import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import type { Socket } from 'node:net';

/** Indicates if the current environment is development. */
const IS_DEV = process.env.NODE_ENV !== 'production';

/** Indicates if the internal server (production) has started */
let hasStarted = false;

/** Map of domains to their handlers. */
const domains = new Map<string, DomainHandler>();

/** -----  Types ----- */

type Cache = Map<string, Buffer | string>;

type RouterCallbackReturnType = undefined | number;
type RouterCallback = (req: IncomingMessage, res: ServerResponse, route: string) => RouterCallbackReturnType | Promise<RouterCallbackReturnType>;
type HandlerCallback = (req: IncomingMessage, res: ServerResponse) => RouterCallbackReturnType | Promise<RouterCallbackReturnType>;
type DomainCallback = (handler: DomainHandler) => void;

type ServeArgument = string | ServeOptions;
type ServeOptions = {
	/** The directory to serve files from. */
	root: string;

	/** An array of patterns to match files. */
	match?: RegExp[];
}

/** -----  Classes ----- */

/** IncomingMessage is an extension of http.IncomingMessage that adds additional methods. */
class IncomingMessage extends http.IncomingMessage {
	constructor(socket: Socket) {
		super(socket);
	}
}

/** ServerResponse is an extension of http.ServerResponse that adds additional methods.*/
class ServerResponse<Request extends http.IncomingMessage = http.IncomingMessage> extends http.ServerResponse<Request> {
	constructor(req: Request) {
		super(req);
	}
}

class DomainHandler {
	public domain: string;
	public privateKey: string;
	public certificate: string;

	private routes = new Array<[string, RouterCallback]>();
	private handlers = new Map<number, HandlerCallback>();

	private isIntendingToSort = false;

	constructor(domain: string) {
		this.domain = domain;

		this.privateKey = '/etc/letsencrypt/live/' + domain + '/privkey.pem';
		this.certificate = '/etc/letsencrypt/live/' + domain + '/fullchain.pem';
	}

	/**
	 * Handles a status code for this domain.
	 * @param statusCode - The status code to handle.
	 * @param req - The request.
	 * @param res - The response.
	 */
	async handleStatusCode(statusCode: number, req: IncomingMessage, res: ServerResponse): Promise<void> {
		const handler = this.handlers.get(statusCode);
		if (handler !== undefined)
			await handler(req, res);
		else
			res.writeHead(statusCode).end();
	}

	/**
	 * Handles a request for this domain.
	 * @param req - The request.
	 * @param res - The response.
	 */
	async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		try {
			for (const [path, callback] of this.routes) {
				if (req.url.startsWith(path)) {
					const result: RouterCallbackReturnType = await callback(req, res, path);
					if (result !== undefined)
						await this.handleStatusCode(result, req, res);
					else if (!res.headersSent)
						throw new Error('No response formed for ' + req.url);

					return;
				}
			}

			await this.handleStatusCode(404, req, res);
		} catch (err) {
			// TODO: Provide this error to a generic error handler for diagnostics?
			console.error(err);

			await this.handleStatusCode(500, req, res);
		}
	}

	cache(cache: Cache): void {
		// TODO: Implement.
	}

	route(path: string, route: RouterCallback): void {
		this.routes.push([path, route]);

		// Instead of resorting the routes every time a new route is added, schedule
		// a sort to happen on the next tick. This allows multiple routes to be added
		// in succession without resorting the routes multiple times.
		if (!this.isIntendingToSort) {
			this.isIntendingToSort = true;
			setImmediate(() => {
				// Sort the routes by length, longest first. This ensures that the
				// most specific routes are checked first.
				this.routes.sort((a, b) => b[0].length - a[0].length);
				this.isIntendingToSort = false;
			});
		}
	}

	handle(status: number, callback: HandlerCallback): void {
		this.handlers.set(status, callback);
	}

	getCacheFor(file: string): Cache {
		// TODO: Implement.
		return null;
	}
}

/** ----- Internal ----- */

/**
 * Handles an incoming request.
 * @param req - The request.
 * @param res - The response.
 */
async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	try {
		const domain: DomainHandler = domains.get(req.headers.host);
		if (domain === undefined)
			throw new Error('No domain handler for ' + req.headers.host);

		await domain.handleRequest(req, res);
	} catch (e) {
		console.error(e);
		// TODO: Can we raise this with a general error handler to make the issue
		// transparent to the developer?
		if (!res.headersSent) {
			res.writeHead(500);
			res.end(http.STATUS_CODES[500]);
		}
	}
}

/** -----  API ----- */

export function serve(rootOrOptions: ServeArgument): RouterCallback {
	// serve is a middleware
	// serve takes either a path or an configuration objects.
	// serve takes static files from a directory and serves them.
	// serve will filter based on `match`, if specified.
	// serve will transform files based on `transform`, if specified.
	// serve will use the configured caches to serve files.
	// serve will prevent directory traversal.
	const options: ServeOptions = typeof rootOrOptions === 'string' ? { root: rootOrOptions } : rootOrOptions;
	options.root = path.resolve(options.root);

	return async (req: IncomingMessage, res: ServerResponse, route: string): Promise<RouterCallbackReturnType> => {
		// Only GET and HEAD requests are supported by this middleware.
		if (req.method !== 'GET' && req.method !== 'HEAD')
			return 405;

		let handle: fs.promises.FileHandle;
		try {
			const urlPath = decodeURIComponent(req.url);
			const filePath = path.join(options.root, urlPath.substring(route.length));
			const resolvedPath = path.resolve(filePath);

			// Prevent directory traversal.
			if (!resolvedPath.startsWith(options.root))
				return 403;

			// Filter based on matches array, if specified.
			if (options.match !== undefined) {
				let matched = false;
				for (const match of options.match) {
					if (match.test(resolvedPath)) {
						matched = true;
						break;
					}
				}

				// If no matches are found, return 404. Returning 403 would be a security
				// risk, as it would reveal the existence of files configured to be hidden.
				if (!matched)
					return 404;
			}

			handle = await fs.promises.open(resolvedPath, 'r');
			const stat = await handle.stat();

			if (!stat.isFile())
				return 403;

			res.writeHead(200, {
				'Content-Type': 'text/plain',
				'Content-Length': stat.size
			});

			// Return early if this is a HEAD request.
			if (req.method === 'HEAD') {
				res.end();
				return;
			}

			const buffer = Buffer.alloc(4096);
			let bytesRead = 0;

			while (bytesRead < stat.size) {
				const read = (await handle.read(buffer, 0, buffer.length, null)).bytesRead;
				if (read > 0) {
					bytesRead += read;
					res.write(buffer.subarray(0, read));
				}
			}

			res.end();
		} catch (e) {
			// Return 404 if the file doesn't exist, otherwise return 500.
			if (e.code === 'ENOENT')
				return 404;

			// TODO: Provide this error to a generic error handler for diagnostics?
			return 500;
		} finally {
			await handle?.close();
		}
	};
}

export function domain(domain: string, callback: DomainCallback): void {
	const handler: DomainHandler = new DomainHandler(domain);

	if (IS_DEV) {
		// In development mode, run a separate http server for each domain which
		// listens on a separate port, this allows for easy local development.

		// Each domain server is mapped to a port based on the domain name.
		// This is done instead of using completely random (or OS assigned) ports
		// so that the port is consistent across restarts, allowing quick reloads.
		const port: number = domain.split('').reduce((a, b) => a + b.charCodeAt(0), 0) % 10000 + 10000;

		http.createServer({}, handleRequest).listen(port, () => {
			console.log(domain + ' initialized at http://localhost:' + port);
		});

		domains.set('localhost:' + port, handler);
	} else {
		// In production mode, run a single https server on port 443.
		// Domain certificates are mapped via the SNICallback.
		if (!hasStarted) {
			https.createServer({}, handleRequest).listen(443);
			hasStarted = true;
		}

		domains.set(domain + ':443', handler);
	}

	callback(handler);
}

export default {
	domain
};