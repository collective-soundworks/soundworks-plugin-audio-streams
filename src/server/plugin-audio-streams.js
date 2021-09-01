import path from 'path';
import fs from 'fs';
import rimraf from 'rimraf';
// import Slicer from './Slicer';
import serveStatic from 'serve-static';
import mkdirp from 'mkdirp';
import urljoin from 'url-join';
import pluginFileSystemFactory from '@soundworks/plugin-filesystem/server';
import Blocked from './Blocked.js';
import { Worker } from 'worker_threads';
import chalk from 'chalk';

// debug
const threshold = 100; // report blockage of more than 100 ms

const blocked = new Blocked(duration => {
  console.log(`Blocked for ${duration} ms`);
}, threshold);

const schema = {
  streamsInfos: {
    type: 'any',
    default: null,
    nullable: true,
  },
};

const pluginFactory = function(AbstractPlugin) {
  return class PluginAudioStreams extends AbstractPlugin {
    constructor(server, name, options) {
      super(server, name);

      // original files in `this.options.directory/`
      // process chunks in `.streams/${this.name}/`
      // public paths begins with `stream/${this.name}

      const defaults = {
        directory: null,
        // publicDirectory: 'public',
        // slice and compression options
        compress: true,
        bitrate: 192, // if compress is true, mp3 bitrate
        duration: 4,
        overlap: 0.1,
        cache: true, // mostly usefull for debug (do not document)
      };

      this.options = this.configure(defaults, options);

      if (!this.options.directory) {
        throw new Error(`[soundworks:${this.name}] no directory given`);
      }

      this.outputDir = path.join(process.cwd(), '.data', 'streams', this.name);
      // handle soundworks.config.env.subpath to work behind a proxy server
      const subpath = server.config.env.subpath;
      this.httpRoute = `${subpath ? `/${subpath}` : ''}/streams/${this.name}`;

      this.streamList = []; // [filename]
      this.streamsInfos = {}; // <filename, chunks>

      this.server.pluginManager.register(`${this.name}-fs`, pluginFileSystemFactory, {
        directories: [{
          name: 'sources',
          path: this.options.directory,
        }]
      });

      this.filesystem = this.server.pluginManager.get(`${this.name}-fs`);

      this.slicer = new Worker(path.join(__dirname, './Slicer.js'), {
        workerData: {
          compress: this.options.compress,
          bitrate: this.options.bitrate,
          duration: this.options.duration,
          overlap: this.options.overlap,
        }
      });

      this.states = new Map();
      this.server.stateManager.registerSchema(`s:${this.name}`, schema);
    }

    async start() {
      if (!this.options.cache) {
        // delete all existing stream slices
        await new Promise(resolve => rimraf(this.outputDir, resolve));
      } else {

        this.streamList = await this.server.db.get(`s:${this.name}:__streamList__`) || [];
      }

      // create target directory if not exists and expose it publicly
      await mkdirp(this.outputDir);
      this.server.router.use(this.httpRoute, serveStatic(this.outputDir));

      this.state = await this.server.stateManager.create(`s:${this.name}`);

      this.started();

      this.filesystem.signals.ready.addObserver(async () => {
        this.filesystem.subscribe(() => this.updateStreams());
        await this.updateStreams(true);

        this.ready();
      });
    }

    connect(client) {
      super.connect(client);
    }

    disconnect(client) {
      super.disconnect(client);
    }

    getChunksOutputDir(streamFilename) {
      const input = path.parse(streamFilename);
      const chunksOutputDir = path.join(this.outputDir, input.dir, input.name);

      return chunksOutputDir;
    }

    async updateStreams(_init = false) {
      const tree = this.filesystem.get('sources');
      const streamList = [];

      const parseDir = (directory, result) => {
        directory.forEach((leaf) => {
          if (leaf.type === 'file') {
            if (leaf.extension.toLowerCase() === '.wav') {
              const pathname = path.relative(this.options.directory, leaf.path);
              result.push(pathname);
            } else {
              // log only on init
              if (_init) {
                console.log(chalk.cyan(`[plugin:${this.name}] ignoring file "${leaf.path}", only .wav files are supported`));
              }
            }
          } else if (leaf.type === 'directory') {
            parseDir(leaf.children, result);
          }
        });
      }

      parseDir(tree.children, streamList);

      const deletedStreams = this.streamList.filter(stream => !streamList.includes(stream));

      // @note - we may have some concurrency problems there
      this.streamList = streamList;

      if (this.options.cache) {
        await this.server.db.set(`s:${this.name}:__streamList__`, this.streamList);
      }

      await this.deleteStreamChunks(deletedStreams);
      await this.createStreamChunks(streamList);
      await this.state.set({ streamsInfos: this.streamsInfos });
    }

    async deleteStreamChunks(streamList) {
      return Promise.all(streamList.map(streamFilename => {
        const chunksOutputDir = this.getChunksOutputDir(streamFilename);

        return new Promise(resolve => rimraf(chunksOutputDir, () => {
          console.log(chalk.cyan(`[plugin:${this.name}] deleted stream: "${streamFilename}"`));
          resolve();
        }));
      }))
    }

    /**
     * Segment audio files chunks for streaming.
     * @param {Array<String>} streamList - list of audio files to chunk.
     */
    async createStreamChunks(streamList) {
      return new Promise((resolve, reject) => {
        const numFiles = streamList.length;
        const publicDirectory = this.options.publicDirectory;

        // prevent hardcore parallel processing that crashes the server
        // (ulimit issue) when lots of streamsDesc to process
        let index = 0;

        const next = () => {
          index += 1;

          if (index >= numFiles) {
            resolve();
          } else {
            processFile();
          }
        }

        const processFile = async () => {
          const streamFilename = streamList[index];
          const streamPathname = path.join(this.options.directory, streamFilename);

          // handle cache - do not process files that have not changed
          const cachedItem = (this.options.cache === false)
            ? null
            : await this.server.db.get(`s:${this.name}:${streamFilename}`);

          const stats = fs.statSync(streamPathname);
          const ctimeMs = stats.ctimeMs;

          if (cachedItem && ctimeMs === cachedItem.ctimeMs) {
            this.streamsInfos[streamFilename] = cachedItem.chunks;
            return next();
          }

          // define stream output directory
          const chunksOutputDir = this.getChunksOutputDir(streamFilename);

          rimraf(chunksOutputDir, async () => {
            const outputExists = fs.existsSync(chunksOutputDir);

            if (!outputExists) {
              await mkdirp(chunksOutputDir);
            }

            this.slicer.once('message', async (chunkList) => {
              const chunks = chunkList.map(chunk => {
                const subpath = path.relative(this.outputDir, chunk.path);
                const url = urljoin(this.httpRoute, subpath);
                // override path with url as clients don't need to know our filesystem
                chunk.path = url;
                chunk.url = url;
                return chunk;
              });

              console.log(chalk.cyan(`[plugin:${this.name}] processed stream: "${streamFilename}" (${chunks.length} chunks)`));
              this.streamsInfos[streamFilename] = chunks;
              // cache informations

              if (this.options.cache === true) {
                await this.server.db.set(`s:${this.name}:${streamFilename}`, { ctimeMs, chunks });
              }

              next();
            });

            this.slicer.postMessage({ streamPathname, chunksOutputDir });
          });
        }

        processFile();
      });
    }
  }
}

export default pluginFactory;
