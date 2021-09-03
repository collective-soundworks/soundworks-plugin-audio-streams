import path from 'path';
import fs from 'fs';
import rimraf from 'rimraf';
// import Slicer from './Slicer';
import serveStatic from 'serve-static';
import mkdirp from 'mkdirp';
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
  details: {
    type: 'any',
    default: null,
    nullable: true,
  },
  list: {
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
      this.httpRoute = `streams-${this.name}`;

      this.streamList = []; // [filename]
      this.streamDetails = {}; // <filename, chunks>

      this.server.pluginManager.register(`${this.name}-fs`, pluginFileSystemFactory, {
        directories: [{
          name: 'sources',
          path: this.options.directory,
        }]
      });

      this.filesystem = this.server.pluginManager.get(`${this.name}-fs`);

      if (!this.server.createNamespacedDb) {
        throw new Error(`[soundworks:${this.name}] @soundwoks/plugin-audio-streams relies on an internal soundworks feature introduced in @soundworks/core#v3.1.0-beta.1, consider updating soundworks to the lastest version to use this plugin`);
      }

      this.db = this.server.createNamespacedDb(this.name);

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
        await new Promise(resolve => rimraf(this.outputDir, resolve));
        await this.db.clear();
      } else {
        this.streamList = await this.db.get('__streamList__') || [];
      }

      // create target directory if not exists and expose it publicly
      await mkdirp(this.outputDir);
      this.server.router.use(this.httpRoute, serveStatic(this.outputDir));

      this.state = await this.server.stateManager.create(`s:${this.name}`);

      this.started();

      // @todo - clean that when Signals are switched to Promises
      // cf. https://github.com/collective-soundworks/soundworks/issues/41
      if (this.filesystem.signals.ready.value) {
        this.filesystem.subscribe(() => this.updateStreams());
        await this.updateStreams(true);

        this.ready();
      } else {
        this.filesystem.signals.ready.addObserver(async () => {
          this.filesystem.subscribe(() => this.updateStreams());
          await this.updateStreams(true);

          this.ready();
        });
      }
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
        await this.db.set('__streamList__', this.streamList);
      }

      await this.deleteStreamChunks(deletedStreams);
      await this.createStreamChunks(streamList);

      // notify clients
      await this.state.set({
        list: Object.keys(this.streamDetails),
        details: this.streamDetails,
      });
    }

    async deleteStreamChunks(streamList) {
      return Promise.all(streamList.map(streamFilename => {
        const chunksOutputDir = this.getChunksOutputDir(streamFilename);

        return new Promise(resolve => rimraf(chunksOutputDir, () => {
          console.log(chalk.cyan(`[plugin:${this.name}] deleted stream: "${streamFilename}"`));
          resolve();
        }));
      }));
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
            : await this.db.get(streamFilename);

          const stats = fs.statSync(streamPathname);
          const ctimeMs = stats.ctimeMs;

          if (cachedItem && ctimeMs === cachedItem.ctimeMs) {
            this.streamDetails[streamFilename] = cachedItem.chunks;
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
                const pathname = path.relative(this.outputDir, chunk.path);
                const pathUrl = pathname.replace(/\\/g, '/');
                // handle soundworks.config.env.subpath to work behind a proxy server
                const subpath = this.server.config.env.subpath;
                const url = `${subpath ? `/${subpath}` : ''}/${this.httpRoute}/${pathUrl}`;
                // override path with url as clients don't need to know our filesystem
                delete chunk.path;
                chunk.url = url;

                return chunk;
              });

              console.log(chalk.cyan(`[plugin:${this.name}] processed stream: "${streamFilename}" (${chunks.length} chunks)`));
              this.streamDetails[streamFilename] = chunks;
              // cache informations

              if (this.options.cache === true) {
                await this.db.set(streamFilename, { ctimeMs, chunks });
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
