<p align="center"><img src="docs/project-logo.png"/></p>

# Spooder &middot; ![typescript](https://img.shields.io/badge/language-typescript-blue) [![license badge](https://img.shields.io/github/license/Kruithne/spooder?color=yellow)](LICENSE) ![npm version](https://img.shields.io/npm/v/spooder?color=c53635) ![bun](https://img.shields.io/badge/runtime-bun-f9f1e1)

`spooder` is a purpose-built web server solution written in [TypeScript](https://www.typescriptlang.org/) for [Bun](https://bun.sh/). It is designed to be highly opinionated with minimal configuration.

> **Warning** - This project is built with specific use-cases in mind and is not intended to be a general-purpose web server. The authors of this project are not responsible for any damage caused by using this software.

> **Warning** - This project is developed for [Bun](https://bun.sh/), which at the time of writing is still experimental. It is not recommended to use this project in production environments unless you understand the risks.

## Structure

`spooder` consists of two primary parts: the `instance` and the `watcher`.

The `instance` is an API that can be imported into a Bun process to scaffold a web server instance. It is intended as a common set of tools for building individiual domain instances.

The `watcher` is a daemon responsible for updating, starting and monitoring a collection of `instance` processes. It is intended to be run as a service on the host machine.

## License
The code in this repository is licensed under the ISC license. See the [LICENSE](LICENSE) file for more information.