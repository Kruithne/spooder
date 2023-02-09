import http from 'node:http';
import https from 'node:https';
import type { AddressInfo, Socket } from 'node:net';

type RouterCallbackReturnType = undefined | number;
type RouterCallback = (req: IncomingMessage, res: ServerResponse) => RouterCallbackReturnType | Promise<RouterCallbackReturnType>;
type Router = { callbacks: Array<RouterCallback>; method: string };

type FallbackHandler = (statusCode: number, req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

type Server = http.Server | https.Server;
type ServerOptions = http.ServerOptions | https.ServerOptions;
type ServerFactory = (options: ServerOptions, requestListener: http.RequestListener) => Server;

const defaultFallbackHandler: FallbackHandler = (statusCode, req, res) => {
	res.writeHead(statusCode);
	res.end(statusCode + ' ' + http.STATUS_CODES[statusCode]);
};

class IncomingMessage extends http.IncomingMessage {
	constructor(socket: Socket) {
		super(socket);
	}
}

class ServerResponse<Request extends http.IncomingMessage = http.IncomingMessage> extends http.ServerResponse<Request> {
	constructor(req: Request) {
		super(req);
	}

	/**
	 * Sends a JSON response.
	 * @param data - The data to send.
	 * @param statusCode - The status code to send.
	 */
	json(data: unknown, statusCode: number = 200): void {
		const json = JSON.stringify(data);
		this.writeHead(statusCode, {
			'Content-Type': 'application/json',
			'Content-Length': Buffer.byteLength(json)
		});

		this.end(json);
	}

	/**
	 * Sends a redirect response.
	 * @param url - The URL to redirect to.
	 * @param statusCode - The status code to send.
	 */
	redirect(url: string, statusCode: number = 302): void {
		this.writeHead(statusCode, {
			'Location': url
		});
		this.end();
	}
}

class ServerApp {
	server: Server;
	#routes = new Map<string, Router>();
	#handlers = new Map<number, RouterCallback>();
	#fallbackHandler: FallbackHandler = defaultFallbackHandler;

	constructor(options: ServerOptions, factory: ServerFactory) {
		if (options === undefined) {
			options = { IncomingMessage, ServerResponse };
		} else {
			options.IncomingMessage ??= IncomingMessage;
			options.ServerResponse ??= ServerResponse;
		}

		this.server = factory(options, async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
			let statusFallback = 404;
			for (const [routePath, router] of this.#routes) {
				// Check if the route matches.
				if (req.url?.startsWith(routePath)) {
					// If the route exists but does not listen to this method, return 405: Method Not Allowed.
					if (router.method !== undefined && router.method !== req.method) {
						statusFallback = 405;
						break;
					}

					// Iterate through the callback tree, halting when a callback returns a status code.
					let dropRoute = false;
					for (const callback of router.callbacks) {
						let statusCode: number;

						try {
							statusCode = await callback(req, res);
						} catch (err) {
							// TODO: Expose error in some meainingful way.
							statusCode = 500;
						}

						if (statusCode !== undefined) {
							statusFallback = statusCode;
							dropRoute = true;
							break;
						}
					}

					if (dropRoute)
						break;

					return;
				}
			}

			// If no route handler was used, check if a status handler exists, otherwise
			// drop to the fallback handler.
			const handler = this.#handlers.get(statusFallback);
			if (handler !== undefined)
				await handler(req, res);
			else
				await this.#fallbackHandler(statusFallback, req, res);
		});
	}

	/**
	 * Routes a request for the specified path.
	 * @param routePath - The path to route to.
	 * @param callback - The callback to call when the route is matched.
	 * @param method - The method to route to.
	 */
	route(routePath: string, callback: RouterCallback | Array<RouterCallback>, method?: string): void {
		if (!Array.isArray(callback))
			callback = [callback];

		this.#routes.set(routePath, { callbacks: callback, method });
	}

	/**
	 * Sets the fallback handler.
	 * @param callback - The callback to call when no route has been found.
	 */
	fallback(callback: FallbackHandler): void {
		this.#fallbackHandler = callback;
	}

	/**
	 * Handles the specified status code if no route has been found.
	 * @param status - HTTP status code.
	 * @param callback - The callback to call when the status code is returned.
	 */
	handle(status: number, callback: RouterCallback): void {
		this.#handlers.set(status, callback);
	}

	/**
	 * Starts listening on the specified port and hostname.
	 * @param port - The port to listen on.
	 * @param hostname - The hostname to listen on.
	 * @returns Promise that resolves when the server is listening.
	 */
	async listen(port: number, hostname?: string): Promise<number> {
		return new Promise(resolve => {
			this.server.listen(port, hostname, () => {
				const address = this.server.address() as AddressInfo;
				resolve(address.port);
			});
		});
	}

	/**
	 * @returns Promise that resolves when the server is closed.
	 */
	async close(): Promise<void> {
		return new Promise(resolve => {
			this.server.close(() => {
				resolve();
			});
		});
	}
}

/**
 * Creates a server using the http module.
 * @param options - The options to pass to the http module.
 * @returns Server application.
 */
export function createServer(options: http.ServerOptions): ServerApp {
	return new ServerApp(options, http.createServer);
}

/**
 * Creates a server using the https module.
 * @param options - The options to pass to the https module.
 * @returns Server application.
 */
export function createSecureServer(options: https.ServerOptions): ServerApp {
	return new ServerApp(options, https.createServer);
}

export default {
	createServer,
	createSecureServer
};