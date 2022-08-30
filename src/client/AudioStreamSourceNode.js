import { loadAudioBuffer } from './utils.js';

// @note: could probably be implemented with an AudioWorklet
// @note: use setValueCurveAtTime to crossfade between chunks

// @todo:
// - add the 'ended' event
// - pass given `audioContext` to loader instead of creating a new one

class AudioStreamSourceNode {
  constructor(plugin, scheduler) {
    this.audioContext = plugin.options.audioContext;

    this._scheduler = scheduler;
    this._monitorInterval = plugin.options.monitorInterval;
    this._requiredAdvanceThreshold = plugin.options.requiredAdvanceThreshold;
    this._plugin = plugin;

    this._startAt = null;
    this._stopAt = null;
    this._offset = 0;

    this._streamId = null;
    this._buffers = null;
    this._chunkIndex = 0;

    this._playbackRate = 1;
    // @todo (maybe) - implement these...
    // this._loop = false;
    // this._loopStart = 0;
    // this._loopEnd = 0;
    // this._loopStartBufferIndex = null;

    this._nextEngineTime = null;
    this._startCalled = false; // throw error on `start` when `true`
    this._stopped = false; // ignore subsequennt stop calls when already stopped

    this._output = this.audioContext.createGain();
    this._monitorPreload = this._monitorPreload.bind(this);

    this._endedListeners = new Set();
  }

  async _monitorPreload() {
    const now = this._scheduler.getTimeFunction();
    const positionInStream = now - this._startAt + this._offset; // use offset
    const advanceThreshold = positionInStream + this._requiredAdvanceThreshold;
    let index = this._chunkIndex;
    // console.log('monitorPreload - position', position);

    while (index < this._chunks.length && this._chunks[index].start <= advanceThreshold) {
      if (!this._buffers[index]  && !this._chunks[index].isLoading) {
        this._loadBuffer(index);
      }

      index += 1;
    }

    this._monitorPreloadTimeoutId = setTimeout(this._monitorPreload, this._monitorInterval * 1000);
  }

  async _loadBuffer(chunkIndex) {
    this._chunks[chunkIndex].isLoading = true;

    const url = this._chunks[chunkIndex].url;
    const buffer = await loadAudioBuffer(this.audioContext, url);
    this._buffers[chunkIndex] = buffer;

    this._chunks[chunkIndex].isLoading = false;
  }

  connect(dest) {
    this._output.connect(dest);
  }

  disconnect(dest = undefined) {
    this._output.disconnect(dest);
  }

  set streamId(value) {
    const streams = this._plugin.get('details');

    if (!(value in streams)) {
      throw new Error(`[soundworks:${this._plugin.name}] Invalid stream id (see "this.plugin.get('list')")`);
    }

    this._chunks = streams[value];
    this._chunks.forEach((chunk) => chunk.isLoading = false);
    this._buffers = [...this._plugin._preloadCache.get(value)];

    // create sine and cosine curves for setValueCurveAtTime
    const overlapDuration = this._chunks[0].overlapEnd;
    const numSamples = Math.ceil(overlapDuration * this.audioContext.sampleRate / 2);
  }

  get duration() {
    const lastChunk = this._chunks[this._chunks.length - 1];
    const duration = lastChunk.start + lastChunk.duration;
    return duration;
  }

  async start(when = 0, offset = 0, duration = null) {
    if (this._startCalled) {
      // mimic AudioBufferSourceNode behavior
      throw new Error(`[soundworks:${this._plugin.name}] Failed to execute 'start' on 'AudioStreamSourceNode': cannot call start more than once`)
    }

    this._startCalled = true;

    if (when === 0) {
      when = this._scheduler.getTimeFunction();
    }

    this._startAt = when;
    this._offset = offset % this.duration;

    if (parseInt(duration) > 0) {
      this._stopAt = this._startAt + duration;
    } else {
      this._stopAt = this._startAt + this.duration;
    }

    // define chunk index from given offset
    for (let i = 0; i < this._chunks.length; i++) {
      const chunk = this._chunks[i];

      if (this._offset >= chunk.start && this._offset < chunk.start + chunk.duration) {
        this._chunkIndex = i;
        break;
      }
    }

    // load at least first buffer, would be better to have two of them
    // in case the offset use only a very small part of the buffer
    if (!this._buffers[this._chunkIndex]) {
      await this._loadBuffer(this._chunkIndex);
    }

    this._scheduler.add(this, this._startAt);
    this._monitorPreload();
  }

  stop(when = 0) {
    if (!this._startCalled) {
      // mimic AudioBufferSourceNode behavior
      throw new Error(`[soundworks:${this._plugin.name}] Failed to execute 'stop' on 'AudioStreamSourceNode': cannot call stop without calling start first.`)
    }

    if (when === 0) {
      when = this._scheduler.getTimeFunction();
    }

    if (!this._stopped) {
      this._stopAt = when;

      if (this._nextEngineTime && this._stopAt < this._nextEngineTime) {
        this._scheduler.resetEngineTime(this, this._stopAt);
      }
    }
  }

  addEventListener(name, callback) {
    if (name !== 'ended') {
      throw new Error(`[soundworks:${this._plugin.name}] AudioStreamSourceNode only support "ended" event`);
    }

    this._endedListeners.add(callback);
  }

  removeEventListener(name, callback) {
    if (name !== 'ended') {
      throw new Error(`[soundworks:${this._plugin.name}] AudioStreamSourceNode only support "ended" event`);
    }

    this._endedListeners.delete(callback);
  }

  set onended(callback) {
    this._endedListeners.clear();
    this._endedListeners.add(callback);
  }

  // set loop(value) {}
  // set loopStart(value) {}
  // set loopEnd(value) {}

  // scheduled interface
  advanceTime(currentTime, audioTime, dt) {
    if (currentTime >= this._stopAt) {
      clearTimeout(this._monitorPreloadTimeoutId);

      this._src.stop(audioTime);
      this._output.disconnect();
      this._buffers = null; // release all buffers
      this._stopped = true; // subsequent calls to `stop` are no-ops
      this._endedListeners.forEach(callback => callback());

      return null; // remove engine from scheduler
    }

    const positionInStream = currentTime - this._startAt + this._offset;
    const chunk = this._chunks[this._chunkIndex];
    const buffer = this._buffers[this._chunkIndex];
    // release buffer
    this._buffers[this._chunkIndex] = undefined;
    // chunkOffset should be 0 most of the time
    // @note - we need to clamp to zero to avoid floating point errors
    let chunkOffset = Math.max(0, positionInStream - chunk.start);

    // handle late call due to buffering
    const now = this._scheduler.getTimeFunction();
    let late = false;
    if (now > currentTime) {
      late = true;
      chunkOffset += now - currentTime;
      audioTime = this.audioContext.currentTime;
    }

    if (!buffer) {
      console.warn(`[soundworks:${this._plugin.name}] buffer not loaded, aborting buffer (index: ${this._chunkIndex})`);
    } else {
      const fadeInStartPosition = chunkOffset;
      const fadeInDuration = chunkOffset > 0 ? 0.005 : chunk.overlapStart;

      const fadeOutStartPosition = Math.max(chunk.duration, fadeInStartPosition + fadeInDuration);
      const fadeOutDuration = Math.min(chunk.overlapEnd,
        chunk.duration + chunk.overlapEnd - fadeOutStartPosition);

      const env = this.audioContext.createGain();
      env.connect(this._output);
      env.gain.value = 0;

      this._src = this.audioContext.createBufferSource();
      this._src.connect(env);
      this._src.buffer = buffer;
      // test using sync report
      console.log('play buffer with playbackRate:', this._playbackRate);
      this._src.playbackRate.value = this._playbackRate;

      const fadeInStartTime = audioTime;
      let fadeOutStartTime = audioTime + fadeOutStartPosition - chunkOffset;

      if (fadeOutStartTime < fadeInStartTime + fadeInDuration) {
        fadeOutStartTime = fadeInStartTime + fadeInDuration;
      }

      try {
        if (fadeInDuration === 0) { // this is the case on the first chunk
          env.gain.setValueAtTime(1, audioTime);
        } else {
          // our signals are correlated so we must use a linear cross-fade
          env.gain.setValueAtTime(0, fadeInStartTime);
          env.gain.linearRampToValueAtTime(1, fadeInStartTime + fadeInDuration);
        }

        if (fadeOutDuration > 0) { // this is the case on the last chunk
          env.gain.setValueAtTime(1, fadeOutStartTime);
          env.gain.linearRampToValueAtTime(0, fadeOutStartTime + fadeOutDuration);
        }
      } catch(err) {
        console.log(err);
        console.log('late', late);
        console.log('audioTime', currentTime, audioTime, this.audioContext.currentTime);
        console.log('fadeIn:', fadeInStartTime, fadeInDuration);
        console.log('fadeOut:', fadeOutStartTime, fadeOutDuration);
      }

      this._src.start(audioTime, chunkOffset);
    }

    if (this._chunks[this._chunkIndex + 1]) {
      this._chunkIndex += 1;
      this._nextEngineTime = this._startAt - this._offset + this._chunks[this._chunkIndex].start;
    } else { // this is the end of the stream
      this._nextEngineTime = this._stopAt;
    }

    // if a stop position has been defined and is inside the current chunk
    if (this._stopAt < this._nextEngineTime) {
      this._nextEngineTime = this._stopAt;
    }

    return this._nextEngineTime;
  }

}

export default AudioStreamSourceNode;
