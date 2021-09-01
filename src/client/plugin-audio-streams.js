const pluginFactory = function(AbstractPlugin) {

  return class PluginDelay extends AbstractPlugin {
    constructor(server, name, options) {
      super(server, name);

      const defaults = {
        startedDelayTime: 1,
        readyDelayTime: 1,
      };

      this.options = this.configure(defaults, options);
    }

    start() {
      setTimeout(() => {
        this.started();

        setTimeout(() => {

          this.ready();

        }, this.options.readyDelayTime * 1000);
      }, this.options.startedDelayTime * 1000);
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
