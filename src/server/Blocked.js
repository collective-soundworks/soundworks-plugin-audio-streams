export class Blocked {
  /**
   * @callback Blocked~report
   * @param {Number} duration of blockage, in milliseconds
   */

  /**
   * Periodic test for event loop, and report of it was blocked.
   *
   * Note that the constructor starts the periodic check.
   *
   * @see {@link Blocked#stop} to stop the periodic check.
   *
   * @constructs Blocked
   * @param {Blocked~report} callback when blocked for more than
   * threshold
   * @param {Number} threshold in ms
   */
  constructor(callback, threshold = 10) {
    this.callback = callback;
    this.threshold = threshold;
    this.interval = this.threshold * 10;
    this._timeout = undefined;

    if(typeof process !== 'undefined'
       && typeof process.hrtime === 'function') {
      // node version
      this.time = () => {
        const hrtime = process.hrtime();
        return hrtime[0] * 1e3 + hrtime[1] * 1e-6;
      };
    } else if(typeof self !== 'undefined'
              && typeof self.performance !== 'undefined'
              && typeof self.performance.now === 'function') {
      // modern browser
      this.time = () => { return self.performance.now(); };
    } else {
      this.time = () => { return Date.now(); };
    }

    this._tick(this.time() );
  }


  /**
   * Stop the periodic check, that was started by the constructor.
   */
  stop() {
    clearTimeout(this._timeout);
  }

  /**
   * Test for blockage, and schedule next test.
   *
   * @private
   * @function Blocked~_tick
   * @param {Number} start of the previous tick
   */
  _tick(start) {
    const now = this.time();
    const delta = now - (start + this.interval);
    if(typeof this.callback !== 'undefined'
       && delta > this.threshold) {
      this.callback(Math.round(delta) );
    }
   this._timeout = setTimeout( () => { this._tick(now); }, this.interval);
  }
}

export default Blocked;
