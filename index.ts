import http from 'node:http';
import https from 'node:https';
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
type RouterCallback = (req: IncomingMessage, res: ServerResponse) => RouterCallbackReturnType | Promise<RouterCallbackReturnType>;
type DomainCallback = (handler: DomainHandler) => void;

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
	private handlers = new Map<number, RouterCallback>();

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
				if (path === req.url) {
					const result: RouterCallbackReturnType = await callback(req, res);
					if (result !== undefined)
						this.handleStatusCode(result, req, res);
					else if (!res.headersSent)
						throw new Error('No response formed for ' + req.url);

					return;
				}
			}

			this.handleStatusCode(404, req, res);
		} catch (err) {
			// TODO: Provide this error to a generic error handler for diagnostics?
			console.error(err);

			this.handleStatusCode(500, req, res);
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

	handle(status: number, callback: RouterCallback): void {
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