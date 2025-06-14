import { dispatch_report } from './dispatch';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'crypto';
import { Blob } from 'node:buffer';
import { ColorInput } from 'bun';

// region api forwarding
export * from './api_db';
// endregion

// region logging
const ANSI_RESET = '\x1b[0m';

export function log_create_logger(label: string, color: ColorInput = '#16b39e') {
	const ansi = Bun.color(color, 'ansi-256') ?? '\x1b[38;5;6m';
	const prefix = `[${ansi}${label}${ANSI_RESET}] `;

	return (message: string) => {
		process.stdout.write(prefix + message.replace(/\{([^}]+)\}/g, `${ansi}$1${ANSI_RESET}\n`));
	};
}

export function log_list(input: any[], delimiter = ',') {
	return input.map(e => `{${e}}`).join(delimiter);
}

const log_spooder = log_create_logger('spooder', '#16b39e');
export const log = log_create_logger('info', 'blue');

// endregion

// region error handling
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
				resolved_value = await value();
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

	if (process.env.SPOODER_ENV === 'dev') {
		log_spooder(`[{dev}] dispatch_report ${prefix + error_message}`);
		log_spooder('[{dev}] without {--dev}, this would raise a canary report');
		log_spooder(`[{dev}] ${final_err}`);
	} else {
		await dispatch_report(prefix + error_message, final_err);
	}
}

export async function panic(err_message_or_obj: string | object, ...err: object[]): Promise<void> {
	await handle_error('panic: ', err_message_or_obj, ...err);
	process.exit(1);
}

export async function caution(err_message_or_obj: string | object, ...err: object[]): Promise<void> {
	await handle_error('caution: ', err_message_or_obj, ...err);
}

type CallableFunction = (...args: any[]) => any;
type Callable = Promise<any> | CallableFunction;

export async function safe(target_fn: Callable) {
	try {
		if (target_fn instanceof Promise)
			await target_fn;
		else
			await target_fn();
	} catch (e) {
		caution(e as Error);
	}
}
// endregion

// region templates
type ReplacerFn = (key: string) => string | Array<string> | undefined;
type AsyncReplaceFn = (key: string) => Promise<string | Array<string> | undefined>;
type Replacements = Record<string, string | Array<string>> | ReplacerFn | AsyncReplaceFn;

export async function parse_template(template: string, replacements: Replacements, drop_missing = false): Promise<string> {
	let result = '';
	let buffer = '';
	let buffer_active = false;

	const is_replacer_fn = typeof replacements === 'function';

	const template_length = template.length;
	for (let i = 0; i < template_length; i++) {
		const char = template[i];

		if (char === '{' && template[i + 1] === '$') {
			i++;
			buffer_active = true;
			buffer = '';
		} else if (char === '}' && buffer_active) {
			buffer_active = false;

			if (buffer.startsWith('for:')) {
				const loop_key = buffer.substring(4);

				const loop_entries = is_replacer_fn ? await replacements(loop_key) : replacements[loop_key];
				const loop_content_start_index = i + 1;
				const loop_close_index = template.indexOf('{/for}', loop_content_start_index);
				
				if (loop_close_index === -1) {
					if (!drop_missing)
						result += '{$' + buffer + '}';
				} else {
					const loop_content = template.substring(loop_content_start_index, loop_close_index);
					if (loop_entries !== undefined) {
						for (const loop_entry of loop_entries) {
							const inner_content = loop_content.replaceAll('%s', loop_entry);
							result += await parse_template(inner_content, replacements, drop_missing);
						}
					} else {
						if (!drop_missing)
							result += '{$' + buffer + '}' + loop_content + '{/for}';
					}
					i += loop_content.length + 6;
				}
			} else if (buffer.startsWith('if:')) {
				const if_key = buffer.substring(3);
				const if_content_start_index = i + 1;
				const if_close_index = template.indexOf('{/if}', if_content_start_index);

				if (if_close_index === -1) {
					if (!drop_missing)
						result += '{$' + buffer + '}';
				} else {
					const if_content = template.substring(if_content_start_index, if_close_index);
					const condition_value = is_replacer_fn ? await replacements(if_key) : replacements[if_key];

					if (!drop_missing) {
						result += '{$' + buffer + '}' + if_content + '{/if}';
					} else if (condition_value) {
						result += await parse_template(if_content, replacements, drop_missing);
					}
					i += if_content.length + 5;
				}
			} else {
				const replacement = is_replacer_fn ? await replacements(buffer) : replacements[buffer];
				if (replacement !== undefined)
					result += replacement;
				else if (!drop_missing)
					result += '{$' + buffer + '}';
			}
			buffer = '';
		} else if (buffer_active) {
			buffer += char;
		} else {
			result += char;
		}
	}

	return result;
}

export async function get_git_hashes(length = 7): Promise<Record<string, string>> {
	const cmd = ['git', 'ls-tree', '-r', 'HEAD'];
	const process = Bun.spawn(cmd, {
		stdout: 'pipe',
		stderr: 'pipe'
	});

	await process.exited;

	if (process.exitCode as number > 0)
		throw new Error('get_git_hashes() failed, `' + cmd.join(' ') + '` exited with non-zero exit code.');

	const stdout = await Bun.readableStreamToText(process.stdout as ReadableStream);
	const hash_map: Record<string, string> = {};

	const regex = /([^\s]+)\s([^\s]+)\s([^\s]+)\t(.+)/g;
	let match: RegExpExecArray | null;

	while (match = regex.exec(stdout))
		hash_map[match[4]] = match[3].substring(0, length);

	return hash_map;
}

export async function generate_hash_subs(length = 7, prefix = 'hash=', hashes?: Record<string, string>): Promise<Record<string, string>> {	
	const hash_map: Record<string, string> = {};

	if (!hashes)
		hashes = await get_git_hashes(length);

	for (const [file, hash] of Object.entries(hashes))
		hash_map[prefix + file] = hash;

	return hash_map;
}
// endregion

// region serving
export const HTTP_STATUS_CODE = http.STATUS_CODES;

// Create enum containing HTTP methods
type HTTP_METHOD = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS' | 'CONNECT' | 'TRACE';
type HTTP_METHODS = HTTP_METHOD|HTTP_METHOD[];

export function http_apply_range(file: BunFile, request: Request): BunFile {
	const range_header = request.headers.get('range');
	if (range_header !== null) {
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
export type JsonPrimitive = string | number | boolean | null | undefined;
export type JsonArray = JsonSerializable[];

export interface JsonObject {
	[key: string]: JsonSerializable;
}

interface ToJson {
	toJSON(): any;
}

type JsonSerializable = JsonPrimitive | JsonObject | JsonArray | ToJson;

type HandlerReturnType = Resolvable<string | number | BunFile | Response | JsonSerializable | Blob>;
type RequestHandler = (req: Request, url: URL) => HandlerReturnType;
type WebhookHandler = (payload: JsonSerializable) => HandlerReturnType;
type ErrorHandler = (err: Error, req: Request, url: URL) => Resolvable<Response>;
type DefaultHandler = (req: Request, status_code: number) => HandlerReturnType;
type StatusCodeHandler = (req: Request) => HandlerReturnType;

type JSONRequestHandler = (req: Request, url: URL, json: JsonObject) => HandlerReturnType;

export type ServerSentEventClient = {
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

	return http_apply_range(file, request);
}

function route_directory(route_path: string, dir: string, handler: DirHandler): RequestHandler {
	return async (req: Request, url: URL) => {
		const file_path = path.join(dir, url.pathname.slice(route_path.length));

		try {
			const file_stat = await fs.stat(file_path);
			const bun_file = Bun.file(file_path);

			return await handler(file_path, bun_file, file_stat, req, url);
		} catch (e) {
			const err = e as NodeJS.ErrnoException;
			if (err?.code === 'ENOENT')
				return 404; // Not Found

			return 500; // Internal Server Error
		}
	};
}

export function validate_req_json(json_handler: JSONRequestHandler): RequestHandler {
	return async (req: Request, url: URL) => {
		try {
			// validate content type header
			if (req.headers.get('Content-Type') !== 'application/json')
				return 400; // Bad Request

			const json = await req.json();

			// validate json is a plain object
			if (json === null || typeof json !== 'object' || Array.isArray(json))
				return 400; // Bad Request

			return json_handler(req, url, json as JsonObject);
		} catch (e) {
			return 400; // Bad Request
		}
	};
}

function format_query_parameters(search_params: URLSearchParams): string {
	let result_parts = [];

	for (let [key, value] of search_params)
		result_parts.push(`${key}: ${value}`);

	return '\x1b[90m( ' + result_parts.join(', ') + ' )\x1b[0m';
}

function print_request_info(req: Request, res: Response, url: URL, request_time: number): Response {
	const search_params = url.search.length > 0 ? format_query_parameters(url.searchParams) : '';

	// format status code based on range (2xx is green, 4xx is yellow, 5xx is red), use ansi colors.
	const status_fmt = res.status < 300 ? '\x1b[32m' : res.status < 500 ? '\x1b[33m' : '\x1b[31m';
	const status_code = status_fmt + res.status + '\x1b[0m';

	// format request time based on range (0-100ms is green, 100-500ms is yellow, 500ms+ is red), use ansi colors.
	const time_fmt = request_time < 100 ? '\x1b[32m' : request_time < 500 ? '\x1b[33m' : '\x1b[31m';
	const request_time_str = time_fmt + request_time + 'ms\x1b[0m';

	log_spooder(`[${status_code}] {${req.method}} ${url.pathname} ${search_params} [{${request_time_str}}]`);
	return res;
}

function is_valid_method(method: HTTP_METHODS, req: Request): boolean {
	if (Array.isArray(method))
		return method.includes(req.method as HTTP_METHOD);

	return req.method === method;
}

type WebsocketAcceptReturn = object | boolean;
type WebsocketHandlers = {
	accept?: (req: Request) => WebsocketAcceptReturn | Promise<WebsocketAcceptReturn>,
	message?: (ws: WebSocket, message: string) => void,
	message_json?: (ws: WebSocket, message: JsonSerializable) => void,
	open?: (ws: WebSocket) => void,
	close?: (ws: WebSocket, code: number, reason: string) => void,
	drain?: (ws: WebSocket) => void
};

export function http_serve(port: number, hostname?: string) {
	const routes = new Array<[string[], RequestHandler, HTTP_METHODS]>();
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
			// @ts-ignore Response does accept Blob in Bun, typing disagrees.
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
			let pathname = url.pathname;
			if (pathname.length > 1 && pathname.endsWith('/'))
				pathname = pathname.slice(0, -1);
			const route_array = pathname.split('/').filter(e => !(e === '..' || e === '.'));
			let handler: RequestHandler | undefined;
			let methods: HTTP_METHODS | undefined;

			for (const [path, route_handler, route_methods] of routes) {
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
					methods = route_methods;
					break;
				}
			}

			// Check for a handler for the route.
			if (handler !== undefined) {
				if (is_valid_method(methods!, req)) {
					const response = await resolve_handler(handler(req, url), status_code, true);
					if (response instanceof Response)
						return response;

					// If the handler returned a status code, use that instead.
					status_code = response;
				} else {
					status_code = 405; // Method Not Allowed
				}
			} else {
				status_code = 404; // Not Found
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
				return await error_handler(e as Error, req, url);

			return new Response(http.STATUS_CODES[500], { status: 500 });
		}
	}

	type SlowRequestCallback = (req: Request, request_time: number, url: URL) => void;

	let slow_request_callback: SlowRequestCallback | null = null;
	let slow_request_threshold: number = 1000;

	const slow_requests = new WeakSet();

	let ws_message_handler: any = undefined;
	let ws_message_json_handler: any = undefined;
	let ws_open_handler: any = undefined;
	let ws_close_handler: any = undefined;
	let ws_drain_handler: any = undefined;

	const server = Bun.serve({
		port,
		hostname,
		development: false,

		async fetch(req: Request): Promise<Response> {
			const url = new URL(req.url) as URL;
			const request_start = Date.now();

			const response = await generate_response(req, url);
			const request_time = Date.now() - request_start;

			const is_known_slow = slow_requests.has(req);
			if (slow_request_callback !== null && request_time > slow_request_threshold && !is_known_slow)
				slow_request_callback(req, request_time, url);

			if (is_known_slow)
				slow_requests.delete(req);

			return print_request_info(req, response, url, request_time);
		},

		websocket: {
			message(ws, message) {
				ws_message_handler?.(ws, message);

				if (ws_message_json_handler) {
					try {
						if (message instanceof ArrayBuffer)
							message = new TextDecoder().decode(message);
						else if (message instanceof Buffer)
							message = message.toString('utf8');

						const parsed = JSON.parse(message as string);
						ws_message_json_handler(ws, parsed);
					} catch (e) {
						ws.close(1003, 'Unsupported Data');
					}
				}
			},

			open(ws) {
				ws_open_handler?.(ws);
			},

			close(ws, code, reason) {
				ws_close_handler?.(ws, code, reason);
			},

			drain(ws) {
				ws_drain_handler?.(ws);
			}
		}
	});

	log_spooder(`server started on port {${port}} (host: {${hostname ?? 'unspecified'})`);

	return {
		/** Register a handler for a specific route. */
		route: (path: string, handler: RequestHandler, method: HTTP_METHODS = 'GET'): void => {
			if (path.length > 1 && path.endsWith('/'))
				path = path.slice(0, -1);
			routes.push([path.split('/'), handler, method]);
		},

		/** Unregister a specific route */
		unroute: (path: string): void => {
			const path_parts = path.split('/');
			routes.splice(routes.findIndex(([route_parts]) => {
				if (route_parts.length !== path_parts.length)
					return false;

				for (let i = 0; i < route_parts.length; i++) {
					if (route_parts[i] !== path_parts[i])
						return false;
				}

				return true;
			}, 1));
		},

		/** Serve a directory for a specific route. */
		dir: (path: string, dir: string, handler?: DirHandler, method: HTTP_METHODS = 'GET'): void => {
			if (path.endsWith('/'))
				path = path.slice(0, -1);

			routes.push([[...path.split('/'), '*'], route_directory(path, dir, handler ?? default_directory_handler), method]);
		},

		/** Add a route to upgrade connections to websockets. */
		websocket: (path: string, handlers: WebsocketHandlers): void => {
			routes.push([path.split('/'), async (req: Request, url: URL) => {
				let context_data = undefined;
				if (handlers.accept) {
					const res = await handlers.accept(req);
					
					if (typeof res === 'object') {
						context_data = res;
					} else if (!res) {
						return 401; // Unauthorized
					}
				}

				if (server.upgrade(req, { data: context_data }))
					return 101; // Switching Protocols

				return new Response('WebSocket upgrade failed', { status: 500 });
			}, 'GET']);

			ws_message_json_handler = handlers.message_json;
			ws_open_handler = handlers.open;
			ws_close_handler = handlers.close;
			ws_message_handler = handlers.message;
			ws_drain_handler = handlers.drain;
		},

		webhook: (secret: string, path: string, handler: WebhookHandler): void => {
			routes.push([path.split('/'), async (req: Request, url: URL) => {
				if (req.headers.get('Content-Type') !== 'application/json')
					return 400; // Bad Request

				const signature = req.headers.get('X-Hub-Signature-256');
				if (signature === null)
					return 401; // Unauthorized

				const body = await req.json() as JsonSerializable;
				const hmac = crypto.createHmac('sha256', secret);
				hmac.update(JSON.stringify(body));

				const sig_buffer = new Uint8Array(Buffer.from(signature));
				const hmac_buffer = new Uint8Array(Buffer.from('sha256=' + hmac.digest('hex')));

				if (!crypto.timingSafeEqual(sig_buffer, hmac_buffer))
					return 401; // Unauthorized

				return handler(body);
			}, 'POST']);
		},

		/** Register a callback for slow requests. */
		on_slow_request: (callback: SlowRequestCallback, threshold = 1000): void => {
			slow_request_callback = callback;
			slow_request_threshold = threshold;
		},

		/** Mark a request as slow, preventing it from triggering slow request callback. */
		allow_slow_request: (req: Request): void => {
			slow_requests.add(req);
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
		stop: async (immediate = false): Promise<void> => {
			server.stop(immediate);

			while (server.pendingRequests > 0)
				await Bun.sleep(1000);
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
		
				let lastEventTime = Date.now();
				const KEEP_ALIVE_INTERVAL = 15000;
		
				const stream = new ReadableStream({
					type: 'direct',
		
					async pull(controller) {
						stream_controller = controller as ReadableStreamDirectController;
						
						while (!req.signal.aborted) {
							const now = Date.now();
							if (now - lastEventTime >= KEEP_ALIVE_INTERVAL) {
								stream_controller.write(':keep-alive\n\n');
								stream_controller.flush();
								lastEventTime = now;
							}
							
							await Bun.sleep(100); // prevent tight loop
						}
					}
				});
		
				const closed = new Promise<void>(resolve => close_resolver = resolve);
				req.signal.onabort = close_controller;
		
				handler(req, url, {
					message: (message: string) => {
						stream_controller.write('data: ' + message + '\n\n');
						stream_controller.flush();
						lastEventTime = Date.now();
					},
		
					event: (event_name: string, message: string) => {
						stream_controller.write('event: ' + event_name + '\ndata: ' + message + '\n\n');
						stream_controller.flush();
						lastEventTime = Date.now();
					},
		
					close: close_controller,
					closed
				});
				
				return new Response(stream, { 
					headers: {
						'Content-Type': 'text/event-stream',
						'Cache-Control': 'no-cache',
						'Connection': 'keep-alive',
						'X-Accel-Buffering': 'no', // Disable proxy buffering
					}
				});
			}, 'GET']);
		}
	};
}
// endregion