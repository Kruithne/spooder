import { expect, test } from '@jest/globals';
import { createServer } from './index.js';
import http from 'node:http';
import https from 'node:https';

async function getResponseBody(res) {
	const chunks = [];
	res.on('data', chunk => chunks.push(chunk));
	return new Promise(resolve => res.on('end', () => resolve(Buffer.concat(chunks))));
}

async function getResponse(opts, module = http) {
	return new Promise((resolve, reject) => {
		const req = module.request(Object.assign({
			method: 'GET',
			host: 'localhost',
		}, opts), (res) => {
			resolve(res);
		});

		req.on('error', reject);
		req.end();
	});
}

test('http: catch-all route', async () => {
	const app = createServer();
	try {
		const port = await app.listen(0);

		expect(app.server).toBeInstanceOf(http.Server);
		expect(port).toBeGreaterThan(0);

		// Set a route for /hello without a method (catch-all).
		app.route('/hello', (req, res) => {
			const string = 'Hello, client!';
			res.writeHead(200, {
				'Content-Type': 'text/plain',
				'Content-Length': string.length
			});

			res.end(string);
		});

		// All methods from http.METHODS should be supported (except CONNECT/HEAD) but we
		// only need to test the common ones, since the rest are handled by the same code.
		const METHODS = ['GET', 'POST', 'DELETE', 'PUT', 'PATCH'];

		for (const method of METHODS) {
			const res = await getResponse({ port, path: '/hello', method });

			expect(res.statusCode).toBe(200);
			expect(res.headers['content-type']).toBe('text/plain');
			expect(res.headers['content-length']).toBe('14');
			expect((await getResponseBody(res)).toString()).toBe('Hello, client!');
		}
	} finally {
		await app.close();
	}
});

test('http: GET-only route', async () => {
	const app = createServer();
	try {
		const port = await app.listen(0);

		expect(app.server).toBeInstanceOf(http.Server);
		expect(port).toBeGreaterThan(0);

		// Set a route for /hello with a method of GET.
		app.route('/hello', (req, res) => {
			const string = 'Hello, client!';
			res.writeHead(200, {
				'Content-Type': 'text/plain',
				'Content-Length': string.length
			});

			res.end(string);
		}, 'GET');

		// All methods from http.METHODS should be supported (except CONNECT/HEAD) but we
		// only need to test the common ones, since the rest are handled by the same code.
		const METHODS = ['GET', 'POST', 'DELETE', 'PUT', 'PATCH'];

		for (const method of METHODS) {
			const res = await getResponse({ port, path: '/hello', method });

			if (method === 'GET') {
				expect(res.statusCode).toBe(200);
				expect(res.headers['content-type']).toBe('text/plain');
				expect(res.headers['content-length']).toBe('14');
				expect((await getResponseBody(res)).toString()).toBe('Hello, client!');
			} else {
				expect(res.statusCode).toBe(405);
				expect((await getResponseBody(res)).toString()).toBe('405 Method Not Allowed');
			}
		}
	} finally {
		await app.close();
	}
});

test('http: default fallback handler', async () => {
	const app = createServer();
	try {
		const port = await app.listen(0);

		// Set a route for /hello without a method (catch-all).
		app.route('/hello', (req, res) => {
			const string = 'Hello, client!';
			res.writeHead(200, {
				'Content-Type': 'text/plain',
				'Content-Length': string.length
			});

			res.end(string);
		});

		const res = await getResponse({ port, path: '/world' });

		expect(res.statusCode).toBe(404);
		expect((await getResponseBody(res)).toString()).toBe('404 Not Found');
	} finally {
		await app.close();
	}
});

test('http: add custom statusCode handler', async () => {
	const app = createServer();
	try {
		const port = await app.listen(0);

		// Set a route for /hello without a method (catch-all).
		app.route('/hello', (req, res) => {
			const string = 'Hello, client!';
			res.writeHead(200);
			res.end(string);
		}, 'GET');

		app.handle(405, (req, res) => {
			res.writeHead(418);
			res.end('I\'m a teapot');
		});

		// Requesting /hello with a POST should return a 405, but we've added a custom
		// handler which rewrites the status code to 418.
		let res = await getResponse({ port, path: '/hello', method: 'POST' });

		expect(res.statusCode).toBe(418);
		expect((await getResponseBody(res)).toString()).toBe('I\'m a teapot');

		// Requesting /world should return a 404, which should still be the default handler.
		res = await getResponse({ port, path: '/world' });

		expect(res.statusCode).toBe(404);
		expect((await getResponseBody(res)).toString()).toBe('404 Not Found');
	} finally {
		await app.close();
	}
});

test('http: add custom fallback handler', async () => {
	const app = createServer();
	try {
		const port = await app.listen(0);

		// Set a route for /hello without a method (catch-all).
		app.route('/hello', (req, res) => {
			const string = 'Hello, client!';
			res.writeHead(200);
			res.end(string);
		}, 'GET');

		app.handle(405, (req, res) => {
			res.writeHead(418);
			res.end('I\'m a teapot');
		});

		app.fallback((statusCode, req, res) => {
			res.writeHead(200);
			res.end('Hello, teapot!');
		});

		// Requesting /hello with a POST should return a 405 rewritten to 418.
		let res = await getResponse({ port, path: '/hello', method: 'POST' });

		expect(res.statusCode).toBe(418);
		expect((await getResponseBody(res)).toString()).toBe('I\'m a teapot');

		// Requesting a non-existent route should fall through to the custom fallback handler.
		res = await getResponse({ port, path: '/world' });

		expect(res.statusCode).toBe(200);
		expect((await getResponseBody(res)).toString()).toBe('Hello, teapot!');
	} finally {
		await app.close();
	}
});

test('http: middleware chain for route', async () => {
	const app = createServer();
	try {
		const port = await app.listen(0);

		// Set a route for /hello with multiple middleware functions.
		app.route('/hello', [
			(req, res) => {
				res.setHeader('X-Test-Header', 'foo');
			},

			(req, res) => {
				res.writeHead(200);
				res.end('Hello, client!');
			}
		], 'GET');

		const res = await getResponse({ port, path: '/hello' });

		expect(res.statusCode).toBe(200);
		expect(res.headers['x-test-header']).toBe('foo');
		expect((await getResponseBody(res)).toString()).toBe('Hello, client!');
	} finally {
		await app.close();
	}
});

test('http: middleware chain with async function', async () => {
	const app = createServer();
	try {
		const port = await app.listen(0);

		// Set a route for /hello with multiple middleware functions.
		app.route('/hello', [
			async (req, res) => {
				res.setHeader('X-Test-Header', 'foo');

				// Wait 100ms to simulate an async operation.
				await new Promise(resolve => setTimeout(resolve, 100));
			},

			(req, res) => {
				res.writeHead(200);
				res.end('Hello, client!');
			}
		], 'GET');

		const res = await getResponse({ port, path: '/hello' });

		expect(res.statusCode).toBe(200);
		expect(res.headers['x-test-header']).toBe('foo');
		expect((await getResponseBody(res)).toString()).toBe('Hello, client!');
	} finally {
		await app.close();
	}
});

test('http: middleware chain with status code rejection', async () => {
	const app = createServer();
	try {
		const port = await app.listen(0);

		// Set a route for /hello with multiple middleware functions.
		app.route('/hello', [
			(req, res) => {
				res.setHeader('X-Test-Header', 'foo');
				return 500;
			},

			(req, res) => {
				// This should never be called since the previous function returned a status code.
				res.writeHead(418);
				res.end('I\'m a teapot');
			}
		], 'GET');

		const res = await getResponse({ port, path: '/hello' });

		expect(res.statusCode).toBe(500);
		expect(res.headers['x-test-header']).toBe('foo');
		expect((await getResponseBody(res)).toString()).toBe('500 Internal Server Error');
	} finally {
		await app.close();
	}
});

test('http: using res.json()', async () => {
	const app = createServer();
	try {
		const port = await app.listen(0);

		// Set a route for /hello with multiple middleware functions.
		app.route('/hello', (req, res) => {
			res.json({ message: 'Hello, client!' });
		}, 'GET');

		const res = await getResponse({ port, path: '/hello' });

		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toBe('application/json');
		expect(res.headers['content-length']).toBe(String(Buffer.byteLength('{"message":"Hello, client!"}', 'utf8')));
		expect((await getResponseBody(res)).toString()).toBe('{"message":"Hello, client!"}');
	} finally {
		await app.close();
	}
});

test('http: using res.json() with a custom status code', async () => {
	const app = createServer();
	try {
		const port = await app.listen(0);

		// Set a route for /hello with multiple middleware functions.
		app.route('/hello', (req, res) => {
			res.json({ message: 'Hello, client!' }, 418);
		}, 'GET');

		const res = await getResponse({ port, path: '/hello' });

		expect(res.statusCode).toBe(418);
		expect(res.headers['content-type']).toBe('application/json');
		expect(res.headers['content-length']).toBe(String(Buffer.byteLength('{"message":"Hello, client!"}', 'utf8')));
		expect((await getResponseBody(res)).toString()).toBe('{"message":"Hello, client!"}');
	} finally {
		await app.close();
	}
});

test('http: using res.redirect()', async () => {
	const app = createServer();
	try {
		const port = await app.listen(0);

		// Set a route for /hello with multiple middleware functions.
		app.route('/hello', (req, res) => {
			res.redirect('/world');
		}, 'GET');

		const res = await getResponse({ port, path: '/hello' });

		expect(res.statusCode).toBe(302);
		expect(res.headers.location).toBe('/world');
		expect((await getResponseBody(res)).toString()).toBe('');
	} finally {
		await app.close();
	}
});

test('http: using res.redirect() with a custom status code', async () => {
	const app = createServer();
	try {
		const port = await app.listen(0);

		// Set a route for /hello with multiple middleware functions.
		app.route('/hello', (req, res) => {
			res.redirect('/world', 307);
		}, 'GET');

		const res = await getResponse({ port, path: '/hello' });

		expect(res.statusCode).toBe(307);
		expect(res.headers.location).toBe('/world');
		expect((await getResponseBody(res)).toString()).toBe('');
	} finally {
		await app.close();
	}
});