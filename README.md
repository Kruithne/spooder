<p align="center"><img src="docs/project-logo.png"/></p>

# Spooder - A Tiny Middleware Manager
![tests status](https://github.com/Kruithne/spooder/actions/workflows/github-actions-test.yml/badge.svg) [![license badge](https://img.shields.io/github/license/Kruithne/spooder?color=blue)](LICENSE)

`spooder` is a lightweight middleware manager that sits atop the Node.js HTTP/HTTPS server with the goal of being simple to use and easy to extend.

- Tiny footprint with zero dependencies by default.
- Minimal API surface and configuration.
- Full [TypeScript](https://www.typescriptlang.org/) definitions.
- Supports both HTTP and HTTPS.
- Modern JavaScript syntax (ES6+).

## Why does this exist?

There's plenty of big fish in the pond when it comes to middleware; spooder is not designed to be one of them, in-fact it purposely does as little as possible, giving you complete control from the ground up.

With zero dependencies out of the box, spooder doesn't come with endless bells and whistles that you need to configure or turn off, it's designed to be as lightweight as possible, allowing you to extend it with it the way you want.

## Installation
```bash
npm install spooder
```

## Getting Started

```js
import { createServer } from 'spooder';

const app = createServer({ /* Options */ });

app.route('/', (req, res) => {
	res.writeHead(200);
	res.end('Hello World!');
});

await app.listen(8080);
```

In the above example, we create a basic HTTP server that listens on port 8080 and responds with "Hello World!" when a request is made to any path. Let's take a look at each part of the example in more detail.

```js
const app = createServer({ /* Options */ });
```

`createServer` is a factory function that creates a new instance of the `ServerApp` class, which is a super thin layer over the Node.js HTTP server. This is the main entry point for all middleware and routing.

The `options` parameter is an optional `http.ServerOptions` object that is passed directly to the Node.js HTTP server. This is useful for configuring SSL certificates, etc. There are no spooder-specific options.

`createSecureServer` works exactly the same, but for HTTPS servers; the spooder API is identical for both.

```js
app.route('/', (req, res) => {
	res.writeHead(200);
	res.end('Hello World!');
}, 'GET');
```

`app.route` is the main method for registering middleware and routing. The first parameter is the path to match against. It should be noted that this is a prefix match, so `/` will match all paths, `/foo` will match `/foo` and `/foo/bar`, etc.

The `req` and `res` parameters are extensions of the standard Node.js HTTP request and response objects, providing the same API. In the above example, we set the status code to 200 and respond with "Hello World!".

> **Hands-off**: Spooder does not automatically set a status code or end the response, this is left up to the developer to ensure full control over the response.

The last parameter we passed to `app.route` is the HTTP method to match against. This can be anything from `http.METHODS`, such as `GET`, `POST`, `PUT`, `DELETE`, etc. If no method is specified, all methods will be matched.

```js
await app.listen(8080);
```

Lastly, we call `app.listen(port, hostname)` to start the server. This is identical to the `.listen()` function on a Node.js HTTP server, with the exception that it returns a promise instead of accepting a callback.

## Middleware

In the first example, we registered a basic routing function. So far, we haven't actually gained much over the standard Node.js API, so let's take a look at how we can use a chain of middleware to handle a request.

```js
app.route('/foo', [
	async (req, res) => {
		const isLoggedIn = await checkIfUserIsLoggedIn();
		if (!isLoggedIn)
			return 401;
	}
	(req, res) => {
		res.writeHead(200);
		res.end('Welcome back!');
	}
]);
```

In this example, instead of providing a single function to `app.route`, we provide an array of functions. Each function in the array is a middleware function, which is executed in order.

- If a function is an `async` function, it will be awaited before the next function in the chain is executed.
- If a function returns `undefined`, the next function in the chain will be executed.
- If a function returns a `number`, the chain will be aborted and the response will be ended with the status code.

Why would we want to do this? Given the example above, we can extract the logic for checking if a user is logged in into a separate function and then re-use it in multiple routes. This is a very basic example, but it's a good starting point for understanding how middleware works.

```js
const isLoggedIn = async (req, res) => {
	const isLoggedIn = await checkIfUserIsLoggedIn();
	if (!isLoggedIn)
		return 401;
};

app.route('/foo', [
	isLoggedIn,
	(req, res) => {
		res.writeHead(200);
		res.end('Welcome to foo!');
	}
]);

app.route('/bar', [
	isLoggedIn,
	(req, res) => {
		res.writeHead(200);
		res.end('Welcome to bar!');
	}
]);
```

## Response Helpers

Spooder provides a few small helper functions that reduce the amount of boilerplate code required to respond to a request. These functions are exposed on the `res` object, which is an extension of the standard Node.js HTTP response object.

### `res.json()`

A common task when building an API is to respond with JSON. The following code covers the most common implementation of this:

```js
app.route('/data/current-weather', (req, res) => {
	const data = await getCurrentWeatherData();
	const json = JSON.stringify(data);

	res.writeHead(200, {
		'Content-Type': 'application/json',
		'Content-Length': Buffer.byteLength(json)
	});
	res.end(json);
});
```

Using `res.json()`, we can reduce this to the following with identical functionality:

```js
app.route('/data/current-weather', async (req, res) => {
	res.json(await getCurrentWeatherData());
});
```

By default, the status code `200` will be used. This can be overridden by passing a second parameter to `res.json()` with a status code of your choice.

```js
app.route('/data/current-weather', async (req, res) => {
	res.json(await getCurrentWeatherData(), 418);
});
```

### `res.redirect()`

Another common task is to redirect a user to another page. The following code covers the most common implementation of this:

```js
app.route('/login', (req, res) => {
	res.writeHead(302, {
		'Location': '/login.html'
	});
	res.end();
});
```

Using `res.redirect()`, we can reduce this to the following with identical functionality:

```js
app.route('/login', (req, res) => {
	res.redirect('/login.html');
});
```

## Errors

In the event that an error occurs somewhere in the middleware chain, the following priority list will be used to determine the error. If any of them are not defined or throw an error, the next one will be used.

1. Middleware registered with `app.route()` (we're assuming something in this chain throws an error).
2. Handler for status code 500 registered with `app.handle(500, (req, res) => {})`.
3. Fallback handler registered with `app.fallback(() => {code, req, res})`.
4. The internal default fallback handler.

By design, all errors that occur in the middleware chain and inside the handlers are swallowed. This is to prevent the server from crashing if an error occurs. In the event that you want to listen for errors, for logging or debugging purposes, you can register an error listener.

```js
app.error((err, req, res) => {
	// Log the error somewhere!
});
```

> **Note**: The error handler should only be used for observing errors. Mutating req/res objects in the error handler is not recommended. Additionally, async error listeners are not awaited and will not affect the normal error handling flow.

## Handlers and Fallback

In the interest of being hands-off, spooder covers very little ground when it comes to handling requests. This is by design, as it allows you to implement your own logic for handling requests.

If something goes wrong, spooder will drop to an internal fallback handler. This handler simply ends the response with a status code and writes "XXX Status Message" to the response body (e.g "404 Not Found").

There are three scenarios where the fallback handler will be used:
- If a route is not found: `(404 Not Found)`.
- If a route is found, but the HTTP method does not match: `(405 Method Not Allowed)`.
- If a route is found, but the middleware chain throws an error: `(500 Internal Server Error)`.
- If a route is found, but the middleware chain returns a status code: `(XXX Status Message)`.

> **Note**: Spooder uses the status code messages from the `http.STATUS_CODES` object.

You can replace the fallback handler with your own by calling `app.fallback((statusCode, req, res) => {})`. The `statusCode` parameter is the status code that was returned by the middleware chain. The `req` and `res` parameters are the standard Node.js HTTP request and response objects.

```js
// Instead of returning plain text, we can return a JSON response.
app.fallback((statusCode, req, res) => {
	res.writeHead(statusCode, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({
		statusCode: statusCode,
		statusMessage: http.STATUS_CODES[statusCode]
	}));
});
```

In addition to a fallback function, we can also register handlers for specific status codes. For example, if we want to provide a custom 404 page, we can do so by calling `app.handler(404, (req, res) => {})`.

```js
app.handler(404, (req, res) => {
	res.writeHead(404, { 'Content-Type': 'text/html' });
	res.end('<h1>404 Not Found</h1>'); // Provide a custom 404 page.
});
```

If a handler exists for a status code, it will be used instead of the fallback handler. If no handler exists, the fallback handler will be used.

## Contributing / Feedback / Issues
Feedback, bug reports and contributions are welcome. Please use the [GitHub issue tracker](https://github.com/Kruithne/spooder/issues) and follow the guidelines found in the [CONTRIBUTING](CONTRIBUTING.md) file.

## License
The code in this repository is licensed under the ISC license. See the [LICENSE](LICENSE) file for more information.