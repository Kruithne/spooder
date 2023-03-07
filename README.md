<p align="center"><img src="docs/project-logo.png"/></p>

# Spooder &middot; [![license badge](https://img.shields.io/github/license/Kruithne/spooder?color=blue)](LICENSE)  ![npm version](https://img.shields.io/npm/v/spooder?color=blue)

`spooder` a purpose-built web server built with [TypeScript](https://www.typescriptlang.org/) and [Node.js](https://nodejs.org/en/) that is specifically designed to run [my projects](https://github.com/Kruithne).

> **Warning** - This is not built for general-purpose use. I take no responsibility for any issues that may arise from using it.


### Why did you make this?

I maintain a large number of projects both personally and professionally that require web servers. For over a decade they have been running on [Apache](https://httpd.apache.org/)/[Nginx](https://www.nginx.com/)/[PHP](https://www.php.net/). While this has served me well, I decided it was time for change.

### Should I use it?

If it serves your needs and you're happy with it, then please feel free. If you are looking for a general-purpose web server that can be configured to your specific needs, I recommend [Express](https://expressjs.com/).

### Why does it lack X feature?

Functionality is added to `spooder` as required, and only if necessary. Since it is not intended for general use, plenty of configuration and checks are omitted in favour of performance and simplicity.

## API

```js
import { domain, serve } from 'spooder';

domain('testdomain.net', server => {
	// Handle requests with custom middleware.
	server.route('/', (req, res) => {
		res.writeHead(200, { 'Content-Type': 'text/plain' });
		res.end('Hello World!');
	});

	// Serve static files from a directory.
	server.route('/static', serve('/var/www/static'));

	// Serve only certain files from a directory.
	server.route('/styles', serve({
		root: '/var/www/static/css',
		match: /\.css$/
	}));
});
```

## CLI

```sh
npm install spooder -g
```

```js
// spooder.config.json
{
	"domains": [
		{ "directory": "/var/www/testdomain.net", },
		{ "directory": "/var/www/otherdomain.net" }
	]
}
```

```js
// /var/www/testdomain.net/spooder.routes.mjs
import { domain } from 'spooder';

domain('testdomain.net', server => {
	server.route('/test', (req, res) => {
		res.writeHead(200, { 'Content-Type': 'text/plain' });
		res.end('Hello World!');
	});
});
```

```sh
spooder
```

## Development / Production

Spooder has two modes of operation that vary dramatically. This is controlled by the `NODE_ENV` environment variable. If `NODE_ENV` is set to `production`, spooder will run in production mode, otherwise it will run in development mode.

### Development Mode

In development mode, spooder does not look for `spooder.config.json` but instead looks directly for a `spooder.routes.mjs` file in the current working directory.

This file is evaluated and any domains specified by `domain()` are loaded as local http servers. To prevent port collision but not randomize ports between restarts, the port is derived from the domain name.

While in development mode, `spooder` will be verbose with logging and both the webhook (for hot-reloading from GitHub) and control panel endpoints will be disabled.

### Production Mode

In production mode, `spooder` will attempt to update the repository of any domain source when it starts. This is done by running `git fetch` and `git pull` in the domain directory. If the domain source is not a git repository, this step is skipped.

Once the domains have been updated, `spooder` will initialize a https server on port 443. All domains specified by `domain()` are served from this.

Logging is kept to a minimum in production mode, and both the webhook and control panel endpoints are enabled.

When the webhook endpoint is enabled, `spooder` will listen for `push` events from GitHub and update the domain source. This is done by running `git fetch` and `git pull` in the domain directory. If the domain source is not a git repository, this step is skipped.

When the control panel endpoint is enabled, `spooder` will listen for requests to `/spooder` and serve a control panel. This control panel provides analytics, management and debugging tools for the domains being served.

## Contributing / Feedback / Issues

Despite being developed for personal use, I am happy to accept contributions and feedback to the project! Please use the [GitHub issue tracker](https://github.com/Kruithne/spooder/issues) and follow the guidelines found in the [CONTRIBUTING](CONTRIBUTING.md) file.

## License
The code in this repository is licensed under the ISC license. See the [LICENSE](LICENSE) file for more information.