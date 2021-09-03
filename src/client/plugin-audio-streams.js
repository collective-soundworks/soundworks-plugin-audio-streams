import { Scheduler } from 'waves-masters';
import AudioStreamSourceNode from './AudioStreamSourceNode.js';
import { loadAudioBuffer } from './utils.js';

const pluginFactory = function(AbstractPlugin) {

  return class PluginAudioStreams extends AbstractPlugin {
    constructor(server, name, options) {
      super(server, name);

      const defaults = {
        audioContext: null,
        monitorInterval: 1, // in seconds
        requiredAdvanceThreshold: 10, // in seconds
      };

      this.options = this.configure(defaults, options);

      this._preloadCache = new Map();
      this._scheduler = null;
    }

    async start() {
      this.state = await this.client.stateManager.attach(`s:${this.name}`);
      this.started();

      await this._preloadStartBuffers();

      this.ready();
    }

    // @todo - delete cache if some stream has been deleted
    async _preloadStartBuffers() {
      const streamDetails = this.state.get('details');
      const NUM_PRELOADED_CHUNKS = 2;
      const preloadPromises = [];

      // preload the NUM_PRELOADED_CHUNKS first chunks for each streams
      for (let streamId in streamDetails) {
        const chunkInfos = streamDetails[streamId];
        const cache = [];
        this._preloadCache.set(streamId, cache);

        for (let i = 0; i < Math.min(NUM_PRELOADED_CHUNKS, chunkInfos.length); i++) {
          const index = i;
          const chunk = chunkInfos[i];

          const promise = loadAudioBuffer(this.options.audioContext, chunk.url)
            .then(buffer => {
              cache[index] = buffer;
              return Promise.resolve();
            }).catch(err => console.log(err));

          preloadPromises.push(promise);
        }
      }

      try {
        Promise.all(preloadPromises);
      } catch(err) {
        console.log(err);
      }
    }

    /**
     * Return an Object that implements the AudioBufferSourceNode API
     */
    createStreamSource(scheduler = null) {
      // lazy scheduler instanciation
      if (scheduler === null && this._scheduler === null) {
        const { audioContext } = this.options;
        this._scheduler = new Scheduler(() => audioContext.currentTime);
      }

      if (scheduler === null) {
        scheduler = this._scheduler
      }

      return new AudioStreamSourceNode(this, scheduler);
    }

    /**
     * @todo - later
     * Return an Object that can be consumed by waves-masters, in a scheduler
     *
     */
    createStreamEngine() {

    }

    get(name) {
      // console.log('@todo - postpone event when start buffers are loaded');
      return this.state.get(name);
    }

    getValues() {
      // console.log('@todo - postpone event when start buffers are loaded');
      return this.state.getValues();
    }

    subscribe(callback) {
      // console.log('@todo - postpone event when start buffers are loaded');
      return this.state.subscribe(callback);
    }

    connect(client) {
      super.connect(client);
    }

    disconnect(client) {
      super.disconnect(client);
    }
  }
}

export default pluginFactory;
