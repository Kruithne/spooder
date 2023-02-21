<p align="center"><img src="docs/project-logo.png"/></p>

# Spooder &middot; ![tests status](https://github.com/Kruithne/spooder/actions/workflows/github-actions-test.yml/badge.svg) ![typescript](https://img.shields.io/badge/%3C%2F%3E-typescript-blue) [![license badge](https://img.shields.io/github/license/Kruithne/spooder?color=blue)](LICENSE)  ![npm version](https://img.shields.io/npm/v/spooder?color=blue)

`spooder` a purpose-built web server built with [TypeScript](https://www.typescriptlang.org/) and [Node.js](https://nodejs.org/en/) that is specifically designed to run [my projects](https://github.com/Kruithne).

> **Warning** - Please read the sections below carefully before using or deploying `spooder` in any environment. It is a personal project and I take no responsibility for any issues that may arise from using it.


### Why did you make this?

I maintain a large number of projects both personally and professionally that require web servers. For over a decade they have been running on [Apache](https://httpd.apache.org/)/[Nginx](https://www.nginx.com/)/[PHP](https://www.php.net/). While this has served me well, I decided it was time for change.

- PHP only exists in my projects because it is required by my current web server stack. `spooder` allows me to focus entirely on [TypeScript](https://www.typescriptlang.org/).
- [Apache](https://httpd.apache.org/) and [Nginx](https://www.nginx.com/) feel dated and come with a lot of features and overhead that I don't need.
- A custom server stack on [Node.js](https://nodejs.org/en/) allows me to build a server that is specifically designed for my projects with no compromises.

### Why not use [Express](https://expressjs.com/)?

I heavily considered [Express](https://expressjs.com/), but ultimately decided that what I wanted to build would be better suited to a custom solution; plus it's fun to build things!

### Can I use it?

Yes, feel free to use `spooder` if it serves your needs. However, keep in mind that it is not intended to be a general-purpose web server.

### Should I use it?

Only if you want to. If you are looking for a general-purpose web server that can be configured to your specific needs, I recommend [Express](https://expressjs.com/).

### Why is this open source / publicly available?

Why not? I didn't see any reason that the project should be should be kept private, despite it's goals. If you find it useful, feel free to use it.

## Contributing / Feedback / Issues

Despite being developed for personal use, I am happy to accept contributions and feedback to the project! Please use the [GitHub issue tracker](https://github.com/Kruithne/spooder/issues) and follow the guidelines found in the [CONTRIBUTING](CONTRIBUTING.md) file.

## License
The code in this repository is licensed under the ISC license. See the [LICENSE](LICENSE) file for more information.