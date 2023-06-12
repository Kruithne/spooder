import { dispatch_report } from './dispatch';
import http from 'node:http';

async function handle_error(prefix: string, err_message_or_obj: string | object, ...err: unknown[]): Promise<void> {
	let error_message = 'unknown error';

	if (typeof err_message_or_obj === 'string') {
		error_message = err_message_or_obj;
		err.unshift(error_message);
	} else {
		if (err_message_or_obj instanceof Error)
			error_message = err_message_or_obj.message;

		err.push(err_message_or_obj);
	}

	// Serialize error objects.
	err = err.map(e => {
		if (e instanceof Error) {
			return {
				name: e.name,
				message: e.message,
				stack: e.stack?.split('\n') ?? []
			}
		}

		return e;
	})

	await dispatch_report(prefix + error_message, err);
}

export async function panic(err_message_or_obj: string | object, ...err: object[]): Promise<void> {
	await handle_error('panic: ', err_message_or_obj, ...err);
	process.exit(1);
}

export async function caution(err_message_or_obj: string | object, ...err: object[]): Promise<void> {
	await handle_error('caution: ', err_message_or_obj, ...err);
}

type HandlerReturnType = any;
type RequestHandler = (req: Request, url: URL) => HandlerReturnType;
type ErrorHandler = (err: Error) => HandlerReturnType;
type DefaultHandler = (req: Request, status_code: number) => HandlerReturnType;
type StatusCodeHandler = (req: Request) => HandlerReturnType;

/** Built-in route handler for redirecting to a different URL. */
export function route_location(redirect_url: string) {
	return (req: Request, url: URL) => {
		return new Response(null, {
			status: 301,
			headers: {
				Location: redirect_url
			}
		});
	};
}

export function serve(port: number) {
	const routes = new Map<string[], RequestHandler>();
	const handlers = new Map<number, StatusCodeHandler>();
	
	let error_handler: ErrorHandler | undefined;
	let default_handler: DefaultHandler | undefined;

	async function resolve_handler(response: HandlerReturnType | Promise<HandlerReturnType>, status_code: number, return_status_code = false): Promise<Response | number> {
		if (response instanceof Promise)
			response = await response;

		// Pre-assembled responses are returned as-is.
		if (response instanceof Response)
			return response;
	
		// Content-type/content-length are automatically set for blobs.
		if (response instanceof Blob)
			return new Response(response, { status: status_code });

		// Status codes can be returned from some handlers.
		if (return_status_code && typeof response === 'number')
			return response;

		// This should cover objects, arrays, etc.
		if (typeof response === 'object')
			return new Response(JSON.stringify(response), { status: status_code, headers: { 'Content-Type': 'application/json' } });
	
		return new Response(String(response), { status: status_code })
	}

	const server = Bun.serve({
		port,
		development: false,

		async fetch(req: Request): Promise<Response> {
			const url = new URL(req.url);
			let status_code = 200;

			const route_array = url.pathname.split('/');
			let handler: RequestHandler | undefined;

			for (const [path, route_handler] of routes) {
				if (path.length !== route_array.length)
					continue;

				let match = true;
				for (let i = 0; i < path.length; i++) {
					const path_part = path[i];

					if (path_part.startsWith(':')) {
						url.searchParams.append(path_part.slice(1), route_array[i]);
						continue;
					}

					if (path_part !== route_array[i]) {
						match = false;
						break;
					}
				}

				if (match) {
					handler = route_handler;
					break;
				}
			}

			// Check for a handler for the route.
			if (handler !== undefined) {
				const response = await resolve_handler(handler(req, url), status_code, true);
				if (response instanceof Response)
					return response;

				// If the handler returned a status code, use that instead.
				status_code = response;
			} else {
				status_code = 404;
			}

			// Fallback to checking for a handler for the status code.
			const status_code_handler = handlers.get(status_code);
			if (status_code_handler !== undefined) {
				const response = await resolve_handler(status_code_handler(req), status_code);
				if (response instanceof Response)
					return response;
			}

			// Fallback to the default handler, if any.
			if (default_handler !== undefined) {
				const response = await resolve_handler(default_handler(req, status_code), status_code);
				if (response instanceof Response)
					return response;
			}

			// Fallback to returning a basic response.
			return new Response(http.STATUS_CODES[status_code], { status: status_code });
		}
	});

	return {
		/** Register a handler for a specific route. */
		route: (path: string, handler: RequestHandler): void => {
			routes.set(path.split('/'), handler);
		},

		/** Register a default handler for all status codes. */
		default: (handler: DefaultHandler): void => {
			default_handler = handler;
		},

		/** Register a handler for a specific status code. */
		handle: (status_code: number, handler: StatusCodeHandler): void => {
			handlers.set(status_code, handler);
		}
	}
}