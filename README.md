<p align="center"><img src="docs/project-logo.png"/></p>

# Spooder &middot; ![typescript](https://img.shields.io/badge/language-typescript-blue) [![license badge](https://img.shields.io/github/license/Kruithne/spooder?color=yellow)](LICENSE) ![npm version](https://img.shields.io/npm/v/spooder?color=c53635) ![bun](https://img.shields.io/badge/runtime-bun-f9f1e1)

`spooder` is a purpose-built web server solution written in [TypeScript](https://www.typescriptlang.org/) for [Bun](https://bun.sh/). It is designed to be highly opinionated with minimal configuration.

> **Warning** - This project is built with specific use-cases in mind and is not intended to be a general-purpose web server. The authors of this project are not responsible for any damage caused by using this software.

> **Warning** - This project is developed for [Bun](https://bun.sh/), which at the time of writing is still experimental. It is not recommended to use this project in production environments unless you understand the risks.

## Installation

```bash
bun add spooder --global
```

## Runner

`spooder` also includes a global command-line tool for running the server. It is recommended that you run this in a `screen` session.

```bash
screen -S spooder # Create a new screen session
cd /var/www/my_server/
spooder
```

`spooder` will load the `module` defined in your `package.json` in a new process using `bun run <module>`. This can be overridden using the `entry` property of the `spooder section` in your `package.json`.

```json
{
	"spooder": {
		"entry": "index.ts"
	}
}
```

In the event that the server exits (regardless of exit code), `spooder` will automatically restart it after a short delay. This delay is configurable in the `spooder` section of your `package.json`.

```json
{
	"spooder": {
		"autoRestart": true, // Defaults to true.
		"restartDelay": 5000, // Defaults to 5000ms.
	}
}
```

When starting your server, `spooder` can automatically update the source code by running `git pull` in the working directory. This feature is disabled by default and can be enabled in the `spooder` section of your `package.json`.

```json
{
	"spooder": {
		"autoUpdate": true // Defaults to false.
	}
}
```

When `autoUpdate` is enabled, your server process can initiate a self-update by terminating with the exit code `205`. This will cause `spooder` to run `git pull` and restart the server, which can be useful for responding to webhooks.

If `autoUpdate` is disabled, all exit codes will be considered a crash and the server will be restarted if `autoRestart` is enabled.

## API

`spooder` exposes a simple API which can be imported into your project for bootstrapping a server in Bun. The API is designed to be minimal to leave control in the hands of the developer and not add overhead for features you may not need.

```ts
import serve from 'spooder'; // WIP
```

## License
The code in this repository is licensed under the ISC license. See the [LICENSE](LICENSE) file for more information.