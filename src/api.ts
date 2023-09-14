import { dispatch_report } from './dispatch';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { log } from './utils';

export class ErrorWithMetadata extends Error {
	constructor(message: string, public metadata: Record<string, unknown>) {
		super(message);
		
		if (this.stack)
			this.stack = this.stack.split('\n').slice(1).join('\n');
	}

	async resolve_metadata(): Promise<object> {
		const metadata = Object.assign({}, this.metadata);
		for (const [key, value] of Object.entries(metadata)) {
			let resolved_value = value;

			if (value instanceof Promise)
				resolved_value = await value;
			else if (typeof value === 'function')
				resolved_value = value();
			else if (value instanceof ReadableStream)
				resolved_value = await Bun.readableStreamToText(value);

			if (typeof resolved_value === 'string' && resolved_value.includes('\n'))
				resolved_value = resolved_value.split(/\r?\n/);

			metadata[key] = resolved_value;
		}

		return metadata;
	}
}

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

	const final_err = Array(err.length);
	for (let i = 0; i < err.length; i++) {
		const e = err[i];

		if (e instanceof Error) {
			const report = {
				name: e.name,
				message: e.message,
				stack: e.stack?.split('\n') ?? []
			} as Record<string, unknown>;

			if (e instanceof ErrorWithMetadata)
				report.metadata = await e.resolve_metadata();

			final_err[i] = report;
		} else {
			final_err[i] = e;
		}
	}

	await dispatch_report(prefix + error_message, final_err);
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
type ErrorHandler = (err: Error) => Response;
type DefaultHandler = (req: Request, status_code: number) => HandlerReturnType;
type StatusCodeHandler = (req: Request) => HandlerReturnType;

type DirOptions = {
	ignore_hidden?: boolean;
	index?: string;
};

function route_directory(route_path: string, dir: string, options: DirOptions): RequestHandler {
	const ignore_hidden = options.ignore_hidden ?? true;

	return async (req: Request, url: URL) => {
		const file_path = path.join(dir, url.pathname.slice(route_path.length));

		if (ignore_hidden && path.basename(file_path).startsWith('.'))
			return 404;

		try {
			const file_stat = await fs.stat(file_path);

			if (file_stat.isDirectory()) {
				if (options.index !== undefined) {
					const index_path = path.join(file_path, options.index);
					const index = Bun.file(index_path);

					if (index.size !== 0)
						return index;
				}
				return 401;
			}

			return Bun.file(file_path);
		} catch (e) {
			const err = e as NodeJS.ErrnoException;
			if (err?.code === 'ENOENT')
				return 404;

			return 500;
		}
	};
}

export const ServerStop = {
	/** Stops the server immediately, terminating in-flight requests. */
	IMMEDIATE: 0,

	/** Stops the server after all in-flight requests have completed. */
	GRACEFUL: 1
};

type ServerStop = typeof ServerStop[keyof typeof ServerStop];

function format_query_parameters(search_params: URLSearchParams): string {
	let result_parts = [];

	for (let [key, value] of search_params)
		result_parts.push(`${key}: ${value}`);

	return '{ ' + result_parts.join(', ') + ' }';
}

function print_request_info(req: Request, res: Response, url: URL, request_start: number): Response {
	const request_time = Date.now() - request_start;
	const search_params = url.search.length > 0 ? format_query_parameters(url.searchParams) : '';
	console.log(`[${res.status}] ${req.method} ${url.pathname} ${search_params} [${request_time}ms]`);
	return res;
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

	async function generate_response(req: Request, url: URL): Promise<Response> {
		let status_code = 200;

		try {
			const route_array = url.pathname.split('/').filter(e => !(e === '..' || e === '.'));
			let handler: RequestHandler | undefined;

			for (const [path, route_handler] of routes) {
				const is_trailing_wildcard = path[path.length - 1] === '*';
				if (!is_trailing_wildcard && path.length !== route_array.length)
					continue;

				let match = true;
				for (let i = 0; i < path.length; i++) {
					const path_part = path[i];

					if (path_part === '*')
						continue;

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
		} catch (e) {
			if (error_handler !== undefined)
				return error_handler(e as Error);

			return new Response(http.STATUS_CODES[500], { status: 500 });
		}
	}

	const server = Bun.serve({
		port,
		development: false,

		async fetch(req: Request): Promise<Response> {
			const url = new URL(req.url);
			const request_start = Date.now();

			const response = await generate_response(req, url);
			print_request_info(req, response, url, request_start);

			return response;
		}
	});

	log('Server started on port ' + port);

	return {
		/** Register a handler for a specific route. */
		route: (path: string, handler: RequestHandler): void => {
			routes.set(path.split('/'), handler);
		},

		/** Register a redirect for a specific route. */
		redirect: (path: string, redirect_url: string): void => {
			routes.set(path.split('/'), (req: Request, url: URL) => {
				return new Response(null, {
					status: 301,
					headers: {
						Location: redirect_url
					}
				});
			});
		},

		/** Serve a directory for a specific route. */
		dir: (path: string, dir: string, options?: DirOptions): void => {
			if (path.endsWith('/'))
				path = path.slice(0, -1);

			routes.set([...path.split('/'), '*'], route_directory(path, dir, options ?? {}));
		},

		/** Register a default handler for all status codes. */
		default: (handler: DefaultHandler): void => {
			default_handler = handler;
		},

		/** Register a handler for a specific status code. */
		handle: (status_code: number, handler: StatusCodeHandler): void => {
			handlers.set(status_code, handler);
		},

		/** Register a handler for uncaught errors. */
		error: (handler: ErrorHandler): void => {
			error_handler = handler;
		},

		/** Stops the server. */
		stop: (method: ServerStop = ServerStop.GRACEFUL): void => {
			server.stop(method === ServerStop.IMMEDIATE);
		}
	}
}