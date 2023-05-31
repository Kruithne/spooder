<p align="center"><img src="docs/project-logo.png"/></p>

# Spooder &middot; ![typescript](https://img.shields.io/badge/language-typescript-blue) [![license badge](https://img.shields.io/github/license/Kruithne/spooder?color=yellow)](LICENSE) ![npm version](https://img.shields.io/npm/v/spooder?color=c53635) ![bun](https://img.shields.io/badge/runtime-bun-f9f1e1)

`spooder` is a purpose-built web server solution written in [TypeScript](https://www.typescriptlang.org/) for [Bun](https://bun.sh/). It is designed to be highly opinionated with minimal configuration.

> **Warning** - This project is built with specific use-cases in mind and is not intended to be a general-purpose web server. The authors of this project are not responsible for any damage caused by using this software.

> **Warning** - This project is developed for [Bun](https://bun.sh/), which at the time of writing is still experimental. It is not recommended to use this project in production environments unless you understand the risks.

## Installation

```bash
# Installing globally for CLI runner usage.
bun add spooder --global

# Install into local package for API usage.
bun add spooder
```

## Runner

`spooder` includes a global command-line tool for running servers. It is recommended that you run this in a `screen` session.

```bash
screen -S spooder # Create a new screen session
cd /var/www/my_server/
spooder
```

While the intended use of this runner is for web servers, it can be used to run anything. It provides two primary features: automatic updating and restarting.

### Entry Point

`spooder` will attempt to launch the server from the current working directory using the command `bun run index.ts` as a default.

To customize this, provide an alternative command via the `run` configuration.

```json
{
	"spooder": {
		"run": "bun run my_server.ts"
	}
}
```

While `spooder` uses a `bun run` command by default, it is possible to use any command string.

It is possible to chain commands, such as updating your source with `git pull && bun run index.ts`, however it is recommended that `run` is only used to launch the service. Instead, use the `update` property for updating which will fail gracefully and will not block the server from starting.

### Auto Restart

In the event that the server exits (regardless of exit code), `spooder` will automatically restart it after a short delay.

This feature is enabled by default with a delay of `5000` milliseconds. The delay can be changed by providing a value for `autoRestart` in the configuration.

```json
{
	"spooder": {
		"autoRestart": 5000
	}
}
```

If set to `0`, the server will be restarted immediately without delay. If set to `-1`, the server will not be restarted at all.

### Auto Update

When starting your server, `spooder` can automatically update the source code in the working directory. To enable this feature, provide an update command as `update` in the configuration.

```json
{
	"spooder": {
		"update": "git pull && bun install"
	}
}
```
It is worth nothing that if the `update` command fails to execute, the server will still be started. This is preferred over entering a restart loop or failing to start the server at all.

As well as being executed when the server is first started, the `update` command is also run when `spooder` automatically restarts the server after it exits.

You can utilize this to automatically update your server in response to a webhook or other event by simply exiting the process.

```ts
events.on('receive-webhook', () => {
	// <- Gracefully finish processing here.
	process.exit(0);
});
```

## API

`spooder` exposes a simple API which can be imported into your project for bootstrapping a server in Bun. The API is designed to be minimal to leave control in the hands of the developer and not add overhead for features you may not need.

```ts
import serve from 'spooder'; // WIP
```

## License
The code in this repository is licensed under the ISC license. See the [LICENSE](LICENSE) file for more information.