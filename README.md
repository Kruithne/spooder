<p align="center"><img src="docs/project-logo.png"/></p>

# Spooder - A Tiny Web Server
![tests status](https://github.com/Kruithne/spooder/actions/workflows/github-actions-test.yml/badge.svg) [![license badge](https://img.shields.io/github/license/Kruithne/spooder?color=blue)](LICENSE)

`spooder` is a tiny web server written in TypeScript with the goal of being simple to use and easy to extend.

- Zero dependencies by default.
- Minimal API surface and configuration.
- Extensible with middleware.
- Supports both HTTP and HTTPS.
- Full [TypeScript](https://www.typescriptlang.org/) definitions.
- Built for ES6+.

## Why does this exist?

There's plenty of big fish in the pond when it comes to web servers; spooder is not designed to be one of them, in-fact it purposely does as little as possible, giving you complete control from the ground up.

With zero dependencies out of the box, spooder doesn't come with endless bells and whistles that you need to configure or turn off, it's designed to be as lightweight as possible, allowing you to extend it with it the way you want.

## Getting Started
```bash
npm install spooder
```

## Contributing / Feedback / Issues
Feedback, bug reports and contributions are welcome. Please use the [GitHub issue tracker](https://github.com/Kruithne/spooder/issues) and follow the guidelines found in the [CONTRIBUTING](CONTRIBUTING.md) file.

## License
The code in this repository is licensed under the ISC license. See the [LICENSE](LICENSE) file for more information.