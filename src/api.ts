import { dispatch_report } from './dispatch';
import { get_config } from './config';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { log } from './utils';
import crypto from 'crypto';

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

export function template_sub(template: string, replacements: Record<string, string>): string {
	let result = '';
	let buffer = '';
	let buffer_active = false;

	const template_length = template.length;
	for (let i = 0; i < template_length; i++) {
		const char = template[i];

		if (char === '{') {
			buffer_active = true;
			buffer = '';
		} else if (char === '}') {
			buffer_active = false;

			result += replacements[buffer] ?? '{' + buffer + '}';

			buffer = '';
		} else if (buffer_active) {
			buffer += char;
		} else {
			result += char;
		}
	}

	return result;
}

export async function generate_hash_subs(length = 7, prefix = 'hash='): Promise<Record<string, string>> {
	const cmd = ['git', 'ls-tree', '-r', 'HEAD'];
	const process = Bun.spawn(cmd, {
		stdout: 'pipe',
		stderr: 'pipe'
	});

	await process.exited;

	if (process.exitCode as number > 0)
		throw new Error('generate_hash_subs() failed, `' + cmd.join(' ') + '` exited with non-zero exit code.');

	const stdout = await Bun.readableStreamToText(process.stdout as ReadableStream);
	const hash_map: Record<string, string> = {};

	const regex = /([^\s]+)\s([^\s]+)\s([^\s]+)\t(.+)/g;
	let match: RegExpExecArray | null;

	let hash_count = 0;
	while (match = regex.exec(stdout)) {
		hash_map[prefix + match[4]] = match[3].substring(0, length);
		hash_count++;
	}

	return hash_map;
}

type CookieOptions = {
	same_site?: 'Strict' | 'Lax' | 'None',
	secure?: boolean,
	http_only?: boolean,
	path?: string,
	expires?: number,
	encode?: boolean
};

export function set_cookie(res: Response, name: string, value: string, options?: CookieOptions): void {
	let cookie = name + '=';
	if (options !== undefined) {
		cookie += options.encode ? encodeURIComponent(value) : value;

		if (options.same_site !== undefined)
			cookie += '; SameSite=' + options.same_site;

		if (options.secure)
			cookie += '; Secure';

		if (options.http_only)
			cookie += '; HttpOnly';

		if (options.path !== undefined)
			cookie += '; Path=' + options.path;

		if (options.expires !== undefined) {
			const date = new Date(Date.now() + options.expires);
			cookie += '; Expires=' + date.toUTCString();
		}
	} else {
		cookie += value;
	}

	res.headers.append('Set-Cookie', cookie);
}

export function get_cookies(source: Request | Response, decode: boolean = false): Record<string, string> {
	const parsed_cookies: Record<string, string> = {};
	const cookie_header = source.headers.get('cookie');

	if (cookie_header !== null) {
		const cookies = cookie_header.split('; ');
		for (const cookie of cookies) {
			const [name, value] = cookie.split('=');
			parsed_cookies[name] = decode ? decodeURIComponent(value) : value;
		}
	}

	return parsed_cookies;
}

export function apply_range(file: BunFile, request: Request): BunFile {
	const range_header = request.headers.get('range');
	if (range_header !== null) {
		console.log(range_header);
		const regex = /bytes=(\d*)-(\d*)/;
		const match = range_header.match(regex);

		if (match !== null) {
			const start = parseInt(match[1]);
			const end = parseInt(match[2]);

			const start_is_nan = isNaN(start);
			const end_is_nan = isNaN(end);

			if (start_is_nan && end_is_nan)
				return file;

			file = file.slice(start_is_nan ? file.size - end : start, end_is_nan || start_is_nan ? undefined : end);
		}
	}
	return file;
}

// Resolvable represents T that is both T or a promise resolving to T.
type Resolvable<T> = T | Promise<T>;

// PromiseType infers the resolved type of a promise (T) or just T if not a promise.
type PromiseType<T extends Promise<any>> = T extends Promise<infer U> ? U : never;

// The following types cover JSON serializable objects/classes.
type JsonPrimitive = string | number | boolean | null;
type JsonArray = JsonSerializable[];

interface JsonObject {
	[key: string]: JsonSerializable;
}

interface ToJson {
	toJSON(): any;
}

type JsonSerializable = JsonPrimitive | JsonObject | JsonArray | ToJson;

type HandlerReturnType = Resolvable<string | number | BunFile | Response | JsonSerializable>;
type RequestHandler = (req: Request, url: URL) => HandlerReturnType;
type WebhookHandler = (payload: JsonSerializable) => HandlerReturnType;
type ErrorHandler = (err: Error, req: Request, url: URL) => Response;
type DefaultHandler = (req: Request, status_code: number) => HandlerReturnType;
type StatusCodeHandler = (req: Request) => HandlerReturnType;

type ServerSentEventClient = {
	message: (message: string) => void;
	event: (event_name: string, message: string) => void;
	close: () => void;
	closed: Promise<void>;
}

type ServerSentEventHandler = (req: Request, url: URL, client: ServerSentEventClient) => void;

type BunFile = ReturnType<typeof Bun.file>;
type DirStat = PromiseType<ReturnType<typeof fs.stat>>;

type DirHandler = (file_path: string, file: BunFile, stat: DirStat, request: Request, url: URL) => HandlerReturnType;

function default_directory_handler(file_path: string, file: BunFile, stat: DirStat, request: Request): HandlerReturnType {
	// ignore hidden files by default, return 404 to prevent file sniffing
	if (path.basename(file_path).startsWith('.'))
		return 404; // Not Found

	if (stat.isDirectory())
		return 401; // Unauthorized

	return apply_range(file, request);
}

function route_directory(route_path: string, dir: string, handler: DirHandler): RequestHandler {
	return async (req: Request, url: URL) => {
		const file_path = path.join(dir, url.pathname.slice(route_path.length));

		try {
			const file_stat = await fs.stat(file_path);
			const bun_file = Bun.file(file_path);

			return handler(file_path, bun_file, file_stat, req, url);
		} catch (e) {
			const err = e as NodeJS.ErrnoException;
			if (err?.code === 'ENOENT')
				return 404; // Not Found

			return 500; // Internal Server Error
		}
	};
}

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
	const routes = new Array<[string[], RequestHandler]>();
	const handlers = new Map<number, StatusCodeHandler>();
	
	let error_handler: ErrorHandler | undefined;
	let default_handler: DefaultHandler | undefined;

	async function resolve_handler(response: HandlerReturnType | Promise<HandlerReturnType>, status_code: number, return_status_code = false): Promise<Response | number> {
		if (response instanceof Promise)
			response = await response;

		if (response === undefined || response === null)
			throw new Error('HandlerReturnType cannot resolve to undefined or null');

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
			return Response.json(response, { status: status_code });
	
		return new Response(String(response), { status: status_code, headers: { 'Content-Type': 'text/html' } });
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
				return error_handler(e as Error, req, url);

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
			return print_request_info(req, response, url, request_start);
		}
	});

	log('server started on port ' + port);

	return {
		/** Register a handler for a specific route. */
		route: (path: string, handler: RequestHandler): void => {
			routes.push([path.split('/'), handler]);
		},

		/** Serve a directory for a specific route. */
		dir: (path: string, dir: string, handler?: DirHandler): void => {
			if (path.endsWith('/'))
				path = path.slice(0, -1);

			routes.push([[...path.split('/'), '*'], route_directory(path, dir, handler ?? default_directory_handler)]);
		},

		webhook: (secret: string, path: string, handler: WebhookHandler): void => {
			routes.push([path.split('/'), async (req: Request, url: URL) => {
				if (req.method !== 'POST')
					return 405; // Method Not Allowed

				if (req.headers.get('Content-Type') !== 'application/json')
					return 400; // Bad Request

				const signature = req.headers.get('X-Hub-Signature-256');
				if (signature === null)
					return 401; // Unauthorized

				const body = await req.json() as JsonSerializable;
				const hmac = crypto.createHmac('sha256', secret);
				hmac.update(JSON.stringify(body));

				if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from('sha256=' + hmac.digest('hex'))))
					return 401; // Unauthorized

				return handler(body);
			}]);
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
		stop: (immediate = false): void => {
			server.stop(immediate);
		},

		/** Register a handler for server-sent events. */
		sse: (path: string, handler: ServerSentEventHandler) => {
			routes.push([path.split('/'), (req: Request, url: URL) => {			
				let stream_controller: ReadableStreamDirectController;
				let close_resolver: () => void;

				function close_controller() {
					stream_controller?.close();
					close_resolver?.();
				}

				const queue = Array<string>();
				const stream = new ReadableStream({
					type: 'direct',

					async pull(controller: ReadableStreamDirectController) {
						stream_controller = controller;
						while (!req.signal.aborted) {
							if (queue.length > 0) {
								controller.write(queue.shift()!);
								controller.flush();
							} else {
								await Bun.sleep(50);
							}
						}
					}
				});

				const closed = new Promise<void>(resolve => close_resolver = resolve);
				req.signal.onabort = close_controller;

				handler(req, url, {
					message: (message: string) => {
						queue.push('data:' + message + '\n\n');
					},

					event: (event_name: string, message: string) => {
						queue.push('event:' + event_name + '\ndata:' + message + '\n\n');
					},

					close: close_controller,
					closed
				});
				
				return new Response(stream, { headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					'Connection': 'keep-alive'
				}});
			}]);
		}
	}
}