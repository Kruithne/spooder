import { dispatch_report } from './dispatch';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'crypto';
import { Blob } from 'node:buffer';
import { ColorInput } from 'bun';
import packageJson from '../package.json' with { type: 'json' };

// region api forwarding
export * from './api_db';
// endregion

// region workers
type WorkerMessageData = Record<string, any>;
type WorkerEventPipeOptions = {
	use_canary_reporting?: boolean;
};

export interface WorkerEventPipe {
	send: (id: string, data?: object) => void;
	on: (event: string, callback: (data: WorkerMessageData) => Promise<void> | void) => void;
	once: (event: string, callback: (data: WorkerMessageData) => Promise<void> | void) => void;
	off: (event: string) => void;
}

function worker_validate_message(message: any) {
	if (typeof message !== 'object' || message === null)
		throw new ErrorWithMetadata('invalid worker message type', { message });
	
	if (typeof message.id !== 'string')
		throw new Error('missing worker message .id');
}

const log_worker = log_create_logger('worker', 'spooder');
export function worker_event_pipe(worker: Worker, options?: WorkerEventPipeOptions): WorkerEventPipe {
	const use_canary_reporting = options?.use_canary_reporting ?? false;
	const callbacks = new Map<string, (data: Record<string, any>) => Promise<void> | void>();
	
	function handle_message(event: MessageEvent) {
		try {
			const message = JSON.parse(event.data);
			worker_validate_message(message);
			
			const callback = callbacks.get(message.id);
			if (callback !== undefined)
				callback(message.data ?? {});
		} catch (e) {
			log_error(`exception in worker: ${(e as Error).message}`);
			
			if (use_canary_reporting)
				caution('worker: exception handling payload', { exception: e });
		}
	}
	
	if (Bun.isMainThread) {
		log_worker(`event pipe connected {main thread} ⇄ {worker}`);
		worker.addEventListener('message', handle_message);
	} else {
		log_worker(`event pipe connected {worker} ⇄ {main thread}`);
		worker.onmessage = handle_message;
	}
	
	return {
		send: (id: string, data: object = {}) => {
			worker.postMessage(JSON.stringify({ id, data }));
		},
		
		on: (event: string, callback: (data: WorkerMessageData) => Promise<void> | void) => {
			callbacks.set(event, callback);
		},
		
		off: (event: string) => {
			callbacks.delete(event);
		},
		
		once: (event: string, callback: (data: WorkerMessageData) => Promise<void> | void) => {
			callbacks.set(event, async (data: WorkerMessageData) => {
				await callback(data);
				callbacks.delete(event);
			});
		}
	};
}
// endregion

// region utility
const FILESIZE_UNITS = ['bytes', 'kb', 'mb', 'gb', 'tb'];

function filesize(bytes: number): string {
	if (bytes === 0)
		return '0 bytes';
	
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	const size = bytes / Math.pow(1024, i);
	
	return `${size.toFixed(i === 0 ? 0 : 1)} ${FILESIZE_UNITS[i]}`;
}
// endregion

// region logging
export function log_create_logger(label: string, color: ColorInput = 'blue') {
	if (color === 'spooder')
		color = '#16b39e';
	
	const ansi = Bun.color(color, 'ansi-256') ?? '\x1b[38;5;6m';
	const prefix = `[${ansi}${label}\x1b[0m] `;
	
	return (message: string) => {
		process.stdout.write(prefix + message.replace(/\{([^}]+)\}/g, `${ansi}$1\x1b[0m`) + '\n');
	};
}

export function log_list(input: any[], delimiter = ',') {
	return input.map(e => `{${e}}`).join(delimiter);
}

const log_spooder = log_create_logger('spooder', 'spooder');
export const log = log_create_logger('info', 'blue');
export const log_error = log_create_logger('error', 'red');

// endregion

// region cache
type CacheOptions = {
	ttl?: number;
	max_size?: number;
	use_etags?: boolean;
	headers?: Record<string, string>,
	use_canary_reporting?: boolean;
};

type CacheEntry = {
	content: string;
	last_access_ts: number;
	etag?: string;
	content_type: string;
	size: number;
	cached_ts: number;
};

const CACHE_DEFAULT_TTL = 5 * 60 * 60 * 1000; // 5 hours
const CACHE_DEFAULT_MAX_SIZE = 5 * 1024 * 1024; // 5 MB

const log_cache = log_create_logger('cache', 'spooder');

function is_cache_http(target: any): target is ReturnType<typeof cache_http> {
	return target && typeof target === 'object' && 'entries' in target && typeof target.entries === 'object';
}

export function cache_http(options?: CacheOptions) {
	const ttl = options?.ttl ?? CACHE_DEFAULT_TTL;
	const max_cache_size = options?.max_size ?? CACHE_DEFAULT_MAX_SIZE;
	const use_etags = options?.use_etags ?? true;
	const cache_headers = options?.headers ?? {};
	const canary_report = options?.use_canary_reporting ?? false;
	
	const entries = new Map<string, CacheEntry>();
	let total_cache_size = 0;
	
	function get_and_validate_entry(cache_key: string, now_ts: number): CacheEntry | undefined {
		let entry = entries.get(cache_key);
		
		if (entry) {
			entry.last_access_ts = now_ts;
			
			if (now_ts - entry.cached_ts > ttl) {
				log_cache(`access: invalidating expired cache entry {${cache_key}} (TTL expired)`);
				entries.delete(cache_key);
				total_cache_size -= entry.size ?? 0;
				entry = undefined;
			}
		}
		
		return entry;
	}
	
	function store_cache_entry(cache_key: string, entry: CacheEntry, now_ts: number): void {
		const size = entry.size;
		
		if (size < max_cache_size) {
			if (use_etags)
				entry.etag = crypto.createHash('sha256').update(entry.content).digest('hex');
			
			entries.set(cache_key, entry);
			total_cache_size += size;
			
			log_cache(`caching {${cache_key}} (size: {${filesize(size)}}, etag: {${entry.etag ?? 'none'}})`);
			
			if (total_cache_size > max_cache_size) {
				log_cache(`exceeded maximum capacity {${filesize(total_cache_size)}} > {${filesize(max_cache_size)}}, freeing space...`);
				
				if (canary_report) {
					caution('cache exceeded maximum capacity', {
						total_cache_size,
						max_cache_size,
						item_count: entries.size
					});
				}
				
				log_cache(`free: force-invalidating expired entries`);
				for (const [key, cache_entry] of entries.entries()) {
					if (now_ts - cache_entry.last_access_ts > ttl) {
						log_cache(`free: invalidating expired cache entry {${key}} (TTL expired)`);
						entries.delete(key);
						total_cache_size -= cache_entry.size;
					}
				}
				
				if (total_cache_size > max_cache_size) {
					log_cache(`free: cache still over-budget {${filesize(total_cache_size)}} > {${filesize(max_cache_size)}}, pruning by last access`);
					const sorted_entries = Array.from(entries.entries()).sort((a, b) => a[1].last_access_ts - b[1].last_access_ts);
					for (let i = 0; i < sorted_entries.length && total_cache_size > max_cache_size; i++) {
						const [key, cache_entry] = sorted_entries[i];
						log_cache(`free: removing entry {${key}} (size: {${filesize(cache_entry.size)}})`);
						entries.delete(key);
						total_cache_size -= cache_entry.size;
					}
				}
			}
		} else {
			log_cache(`{${cache_key}} cannot enter cache, exceeds maximum size {${filesize(size)} > ${filesize(max_cache_size)}}`);
			
			if (canary_report) {
				caution('cache entry exceeds maximum size', {
					file_path: cache_key,
					size,
					max_cache_size
				});
			}
		}
	}
	
	function build_response(entry: CacheEntry, req: Request, status_code: number): Response {
		const headers = Object.assign({
			'Content-Type': entry.content_type
		}, cache_headers) as Record<string, string>;
		
		if (use_etags && entry.etag) {
			headers['ETag'] = entry.etag;
			
			if (req.headers.get('If-None-Match') === entry.etag)
				return new Response(null, { status: 304, headers });
		}
		
		return new Response(entry.content, { status: status_code, headers });
	}
	
	return {
		entries,
		
		file(file_path: string) {
			return async (req: Request, url: URL) => {
				const now_ts = Date.now();
				let entry = get_and_validate_entry(file_path, now_ts);
				
				if (entry === undefined) {
					const file = Bun.file(file_path);
					const content = await file.text();
					const size = Buffer.byteLength(content);
					
					entry = {
						content,
						size,
						last_access_ts: now_ts,
						content_type: file.type,
						cached_ts: now_ts
					};
					
					store_cache_entry(file_path, entry, now_ts);
				}
				
				return build_response(entry, req, 200);
			};
		},
		
		async request(req: Request, cache_key: string, content_generator: () => string | Promise<string>, status_code = 200): Promise<Response> {
			const now_ts = Date.now();
			let entry = get_and_validate_entry(cache_key, now_ts);
			
			if (entry === undefined) {
				const content = await content_generator();
				const size = Buffer.byteLength(content);
				
				entry = {
					content,
					size,
					last_access_ts: now_ts,
					content_type: 'text/html',
					cached_ts: now_ts
				};
				
				store_cache_entry(cache_key, entry, now_ts);
			}
			
			return build_response(entry, req, status_code);
		}
	};
}
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
type Replacements = Record<string, string | Array<string> | object | object[]> | ReplacerFn | AsyncReplaceFn;

function get_nested_property(obj: any, path: string): any {
	const keys = path.split('.');
	let current = obj;
	
	for (const key of keys) {
		if (current === null || current === undefined || typeof current !== 'object')
			return undefined;
		current = current[key];
	}
	
	return current;
}

export async function parse_template(template: string, replacements: Replacements, drop_missing = false): Promise<string> {
	const is_replacer_fn = typeof replacements === 'function';
	let result = template;
	let previous_result = '';
	
	// Keep processing until no more changes occur (handles nested tags)
	while (result !== previous_result) {
		previous_result = result;
		
		// Parse t-for tags first (outermost structures)
		const for_regex = /<t-for\s+items="([^"]+)"\s+as="([^"]+)"\s*>(.*?)<\/t-for>/gs;
		result = await replace_async(result, for_regex, async (match, entries_key, alias_name, loop_content) => {
			const loop_entries = is_replacer_fn ? await replacements(entries_key) : replacements[entries_key];
			
			if (loop_entries !== undefined && Array.isArray(loop_entries)) {
				let loop_result = '';
				for (const loop_entry of loop_entries) {
					let scoped_replacements: Replacements;
					
					if (typeof replacements === 'function') {
						scoped_replacements = async (key: string) => {
							if (key === alias_name) return loop_entry;
							if (key.startsWith(alias_name + '.')) {
								const prop_path = key.substring(alias_name.length + 1);
								return get_nested_property(loop_entry, prop_path);
							}
							return await replacements(key);
						};
					} else {
						scoped_replacements = {
							...replacements,
							[alias_name]: loop_entry
						};
					}
					
					loop_result += await parse_template(loop_content, scoped_replacements, drop_missing);
				}
				return loop_result;
			} else {
				if (!drop_missing)
					return match;
				
				return '';
			}
		});
		
		// Parse t-if tags
		const if_regex = /<t-if\s+test="([^"]+)"\s*>(.*?)<\/t-if>/gs;
		result = await replace_async(result, if_regex, async (match, condition_key, if_content) => {
			const condition_value = is_replacer_fn ? await replacements(condition_key) : replacements[condition_key];
			
			if (!drop_missing && !condition_value)
				return match;
			if (condition_value)
				return await parse_template(if_content, replacements, drop_missing);
			
			return '';
		});
		
		// Parse {{variable}} tags (innermost)
		const var_regex = /\{\{([^}]+)\}\}/g;
		result = await replace_async(result, var_regex, async (match, var_name) => {
			// Trim whitespace from variable name
			var_name = var_name.trim();
			let replacement;
			
			if (is_replacer_fn) {
				replacement = await replacements(var_name);
			} else {
				// First try direct key lookup (handles hash keys with dots like "hash=.gitignore")
				replacement = replacements[var_name];
				
				// If direct lookup fails and variable contains dots, try nested property access
				if (replacement === undefined && var_name.includes('.')) {
					const dot_index = var_name.indexOf('.');
					const base_key = var_name.substring(0, dot_index);
					const prop_path = var_name.substring(dot_index + 1);
					const base_obj = replacements[base_key];
					
					if (base_obj !== undefined) {
						replacement = get_nested_property(base_obj, prop_path);
					}
				}
			}
			
			if (replacement !== undefined)
				return replacement;
			
			if (!drop_missing)
				return match;
			
			return '';
		});
	}
	
	return result;
}

async function replace_async(str: string, regex: RegExp, replacer_fn: (match: string, ...args: any[]) => Promise<string>): Promise<string> {
	const matches = Array.from(str.matchAll(regex));
	let result = str;
	
	for (let i = matches.length - 1; i >= 0; i--) {
		const match = matches[i];
		const replacement = await replacer_fn(match[0], ...match.slice(1));
		result = result.substring(0, match.index!) + replacement + result.substring(match.index! + match[0].length);
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

interface DirOptions {
	ignore_hidden?: boolean;
	index_directories?: boolean;
	support_ranges?: boolean;
}

let directory_index_template: string | null = null;

async function get_directory_index_template(): Promise<string> {
	if (directory_index_template === null) {
		const template_path = path.join(import.meta.dir, 'template', 'directory_index.html');
		const template_file = Bun.file(template_path);
		directory_index_template = await template_file.text();
	}
	return directory_index_template;
}

function format_date(date: Date): string {
	const options: Intl.DateTimeFormatOptions = {
		year: 'numeric',
		month: 'short',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hour12: true
	};
	return date.toLocaleDateString('en-US', options);
}

function format_date_mobile(date: Date): string {
	const options: Intl.DateTimeFormatOptions = {
		year: 'numeric',
		month: 'short',
		day: '2-digit'
	};
	return date.toLocaleDateString('en-US', options);
}

async function generate_directory_index(file_path: string, request_path: string): Promise<Response> {
	try {
		const entries = await fs.readdir(file_path, { withFileTypes: true });
		let filtered_entries = entries.filter(entry => !entry.name.startsWith('.'));
		filtered_entries.sort((a, b) => {
			if (a.isDirectory() === b.isDirectory())
				return a.name.localeCompare(b.name);
			
			return a.isDirectory() ? -1 : 1;
		});
		
		const base_url = request_path.endsWith('/') ? request_path.slice(0, -1) : request_path;
		const entry_data = await Promise.all(filtered_entries.map(async entry => {
			const entry_path = path.join(file_path, entry.name);
			const stat = await fs.stat(entry_path);
			return {
				name: entry.name,
				type: entry.isDirectory() ? 'directory' : 'file',
				size: entry.isDirectory() ? '-' : filesize(stat.size),
				modified: format_date(stat.mtime),
				modified_mobile: format_date_mobile(stat.mtime),
				raw_size: entry.isDirectory() ? 0 : stat.size
			};
		}));
		
		const template = await get_directory_index_template();
		const html = await parse_template(template, {
			title: path.basename(file_path) || 'Root',
			path: request_path,
			base_url: base_url,
			entries: entry_data,
			version: packageJson.version
		}, true);
		
		return new Response(html, {
			status: 200,
			headers: { 'Content-Type': 'text/html' }
		});
	} catch (err) {
		return new Response('Error reading directory', {
			status: 500,
			headers: { 'Content-Type': 'text/plain' }
		});
	}
}

function default_directory_handler(file_path: string, file: BunFile, stat: DirStat, request: Request): HandlerReturnType {
	// ignore hidden files by default, return 404 to prevent file sniffing
	if (path.basename(file_path).startsWith('.'))
		return 404; // Not Found
	
	if (stat.isDirectory())
		return 401; // Unauthorized
	
	return http_apply_range(file, request);
}

function route_directory(route_path: string, dir: string, handler_or_options: DirHandler | DirOptions): RequestHandler {
	const is_handler = typeof handler_or_options === 'function';
	const handler = is_handler ? handler_or_options as DirHandler : null;
	const options = is_handler ? { ignore_hidden: true, index_directories: false, support_ranges: true } : { ignore_hidden: true, index_directories: false, support_ranges: true, ...handler_or_options as DirOptions };
	
	return async (req: Request, url: URL) => {
		const file_path = path.join(dir, url.pathname.slice(route_path.length));
		
		try {
			const file_stat = await fs.stat(file_path);
			const bun_file = Bun.file(file_path);
			
			if (handler)
				return await handler(file_path, bun_file, file_stat, req, url);
			
			// Options-based handling
			if (options.ignore_hidden && path.basename(file_path).startsWith('.'))
				return 404; // Not Found
			
			if (file_stat.isDirectory()) {
				if (options.index_directories)
					return await generate_directory_index(file_path, url.pathname);
				
				return 401; // Unauthorized
			}
			
			return options.support_ranges ? http_apply_range(bun_file, req) : bun_file;
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

function is_bun_file(obj: any): obj is BunFile {
	return obj.constructor === Blob;
}

function sub_table_merge(target: Record<string, any>, ...sources: (Record<string, any> | undefined | null)[]): Record<string, any> {
	const result = { ...target };
	
	for (const source of sources) {
		if (source == null)
			continue;
		
		for (const key in source) {
			if (source.hasOwnProperty(key)) {
				const sourceValue = source[key];
				const targetValue = result[key];
				
				if (Array.isArray(targetValue) && Array.isArray(sourceValue))
					result[key] = [...targetValue, ...sourceValue];
				else
					result[key] = sourceValue;
			}
		}
	}
	
	return result;
}

async function resolve_bootstrap_content(content: string | BunFile): Promise<string> {
	if (is_bun_file(content))
		return await content.text();

	return content;
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

type BootstrapSub = string | string[];

type BootstrapRoute = {
	content: string | BunFile;
	subs?: Record<string, BootstrapSub>;
};

type BootstrapOptions = {
	base?: string | BunFile;
	routes: Record<string, BootstrapRoute>;
	cache?: ReturnType<typeof cache_http> | CacheOptions;
	cache_bust?: boolean;
	error?: {
		use_canary_reporting?: boolean;
		error_page: string | BunFile;
	},
	
	static?: {
		route: string;
		directory: string;
		sub_ext?: Array<string>;
	},
	
	global_subs?: Record<string, BootstrapSub>;
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
	
	log_spooder(`server started on port {${port}} (host: {${hostname ?? 'unspecified'}})`);
	
	return {
		/** Register a handler for a specific route. */
		route: (path: string, handler: RequestHandler, method: HTTP_METHODS = 'GET'): void => {
			if (path.length > 1 && path.endsWith('/'))
				path = path.slice(0, -1);
			routes.push([path.split('/'), handler, method]);
		},
		
		/** Register a JSON endpoint with automatic content validation. */
		json: (path: string, handler: JSONRequestHandler, method: HTTP_METHODS = 'POST'): void => {
			const json_wrapper: RequestHandler = async (req: Request, url: URL) => {
				try {
					if (req.headers.get('Content-Type') !== 'application/json')
						return 400; // Bad Request
					
					const json = await req.json();
					if (json === null || typeof json !== 'object' || Array.isArray(json))
						return 400; // Bad Request
					
					return handler(req, url, json as JsonObject);
				} catch (e) {
					return 400; // Bad Request
				}
			};
			
			if (path.length > 1 && path.endsWith('/'))
				path = path.slice(0, -1);
			
			routes.push([path.split('/'), json_wrapper, method]);
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
		dir: (path: string, dir: string, handler_or_options?: DirHandler | DirOptions, method: HTTP_METHODS = 'GET'): void => {
			if (path.endsWith('/'))
				path = path.slice(0, -1);
			
			const final_handler_or_options = handler_or_options ?? default_directory_handler;
			routes.push([[...path.split('/'), '*'], route_directory(path, dir, final_handler_or_options), method]);
		},
		
		/** Add a route to upgrade connections to websockets. */
		websocket: (path: string, handlers: WebsocketHandlers): void => {
			routes.push([path.split('/'), async (req: Request) => {
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
			routes.push([path.split('/'), async (req: Request) => {
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
		},
		
		/* Bootstrap a static web server */
		bootstrap: async function(options: BootstrapOptions) {
			const hash_sub_table = options.cache_bust ? await generate_hash_subs() : {};
			const global_sub_table = sub_table_merge(hash_sub_table, options.global_subs);

			let cache = options.cache;
			if (cache !== undefined && !is_cache_http(cache))
				cache = cache_http(cache);

			for (const [route, route_opts] of Object.entries(options.routes)) {
				const content_generator = async () => {
					let content = await resolve_bootstrap_content(route_opts.content);

					if (options.base !== undefined)
						content = await parse_template(await resolve_bootstrap_content(options.base), { content }, false);
					
					const sub_table = sub_table_merge({}, global_sub_table, route_opts.subs);
					content = await parse_template(content, sub_table, true);
					
					return content;
				};
				
				const handler = cache 
					? async (req: Request) => cache.request(req, route, content_generator)
					: async () => content_generator();
				
				this.route(route, handler);
			}

			const error_options = options.error;
			if (error_options !== undefined) {
				const create_error_content_generator = (status_code: number) => async () => {
					const error_text = HTTP_STATUS_CODE[status_code] as string;
					let content = await resolve_bootstrap_content(error_options.error_page);

					if (options.base !== undefined)
						content = await parse_template(await resolve_bootstrap_content(options.base), { content }, false);

					const sub_table = sub_table_merge({
						error_code: status_code.toString(),
						error_text: error_text
					}, global_sub_table);

					content = await parse_template(content, sub_table, true);
					return content;
				};

				const default_handler = async (req: Request, status_code: number): Promise<Response> => {
					if (cache) {
						return cache.request(req, `error_${status_code}`, create_error_content_generator(status_code), status_code);
					} else {
						const content = await create_error_content_generator(status_code)();
						return new Response(content, { status: status_code });
					}
				};

				this.error((err, req) => {
					if (options.error?.use_canary_reporting)
						caution(err?.message ?? err);
	
					return default_handler(req, 500);
				});
				
				this.default((req, status_code) => default_handler(req, status_code));
			}
			
			const static_options = options.static;
			if (static_options) {
				this.dir(static_options.route, static_options.directory, async (file_path, file, stat, request) => {
					// ignore hidden files by default, return 404 to prevent file sniffing
					if (path.basename(file_path).startsWith('.'))
						return 404; // Not Found
					
					if (stat.isDirectory())
						return 401; // Unauthorized

					const ext = path.extname(file_path);
					if (static_options.sub_ext?.includes(ext)) {
						const content = await parse_template(await file.text(), global_sub_table, true);
						return new Response(content, {
							headers: {
								'Content-Type': file.type
							}
						});
					}
					
					return http_apply_range(file, request);
				});
			}
		}
	};
}
// endregion