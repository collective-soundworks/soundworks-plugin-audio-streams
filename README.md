# `@soundworks/plugin-delay` (to update)

> [`soundworks`](https://github.com/collective-soundworks/soundworks) plugin that just defer its initialization. Created for testing the plugin manager life cycle (let us know if you find any other use case from that, ...).

## Table of Contents

<!-- toc -->

- [Installation](#installation)
- [Example](#example)
- [Usage](#usage)
  * [Server installation](#server-installation)
    + [Registering the plugin](#registering-the-plugin)
    + [Requiring the plugin](#requiring-the-plugin)
  * [Client installation](#client-installation)
    + [Registering the plugin](#registering-the-plugin-1)
    + [Requiring the plugin](#requiring-the-plugin-1)
- [Credits](#credits)
- [License](#license)

<!-- tocstop -->

## Installation

```sh
npm install @soundworks/plugin-delay --save
```

## Example

A working example can be found in the [https://github.com/collective-soundworks/soundworks-examples](https://github.com/collective-soundworks/soundworks-examples) repository.

## Usage

### Server installation

#### Registering the plugin

```js
// index.js
import { Server } from '@soundworks/core/server';
import pluginPluginFactory from '@soundworks/plugin-delay/server';

const server = new Server();
server.pluginManager.register('delay', pluginPluginFactory, {
  startedDelayTime: 1,
  readyDelayTime: 1,
}, []);
```

#### Requiring the plugin

```js
// MyExperience.js
import { AbstractExperience } from '@soundworks/core/server';

class MyExperience extends AbstractExperience {
  constructor(server, clientType) {
    super(server, clientType);
    // require plugin in the experience
    this.delay = this.require('delay');
  }
}
```

### Client installation

#### Registering the plugin

```js
// index.js
import { Client } from '@soundworks/core/client';
import pluginPluginFactory from '@soundworks/plugin-delay/client';

const client = new Client();
client.pluginManager.register('delay', pluginPluginFactory, {
  startedDelayTime: 1,
  readyDelayTime: 1,
}, []);
```

#### Requiring the plugin

```js
// MyExperience.js
import { Experience } from '@soundworks/core/client';

class MyExperience extends Experience {
  constructor(client) {
    super(client);
    // require plugin in the experience
    this.delay = this.require('delay');
  }
}
```

## Credits

The code has been initiated in the framework of the WAVE and CoSiMa research projects, funded by the French National Research Agency (ANR).

## License

BSD-3-Clause
