import { dispatch_report } from './dispatch';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'crypto';
import { Blob } from 'node:buffer';
import { ColorInput, SQL } from 'bun';
import packageJson from '../package.json' with { type: 'json' };

// region exit codes
export const EXIT_CODE = {
	SUCCESS: 0,
	GENERAL_ERROR: 1,

	// 3-125 are free for application errors
	SPOODER_AUTO_UPDATE: 42
};

export const EXIT_CODE_NAMES = Object.fromEntries(
	Object.entries(EXIT_CODE).map(([key, value]) => [value, key])
);
// endregion

// region workers
type WorkerMessageData = Record<string, any>;
type WorkerMessage = {
	id: string;
	peer: string;
	data?: WorkerMessageData;
	uuid: string;
	response_to?: string;
};

const RESPONSE_TIMEOUT_MS = 5000;

type WorkerStartCallback = (pool: WorkerPool, worker_id: string) => void;
type WorkerStopCallback = (pool: WorkerPool, worker_id: string, exit_code: number) => void;

export interface WorkerPool {
	id: string;
	send(peer: string, id: string, data?: WorkerMessageData, expect_response?: false): void;
	send(peer: string, id: string, data: WorkerMessageData | undefined, expect_response: true): Promise<WorkerMessage>;
	broadcast: (id: string, data?: WorkerMessageData) => void;
	respond: (message: WorkerMessage, data?: WorkerMessageData) => void;
	on: (event: string, callback: (message: WorkerMessage) => Promise<void> | void) => void;
	once: (event: string, callback: (message: WorkerMessage) => Promise<void> | void) => void;
	off: (event: string) => void;
}

export const WORKER_EXIT_NO_RESTART = 42;
const log_worker = log_create_logger('worker_pool', 'spooder');

type AutoRestartConfig = {
	backoff_max?: number;
	backoff_grace?: number;
	max_attempts?: number;
};

type WorkerPoolOptions = {
	id?: string;
	worker: string | string[];
	size?: number;
	auto_restart?: boolean | AutoRestartConfig;
	response_timeout?: number;
	onWorkerStart?: WorkerStartCallback;
	onWorkerStop?: WorkerStopCallback;
};

type WorkerState = {
	worker: Worker;
	worker_id?: string;
	restart_delay: number;
	restart_attempts: number;
	restart_success_timer: Timer | null;
	worker_path: string;
};

export async function worker_pool(options: WorkerPoolOptions): Promise<WorkerPool> {
	const pipe_workers = new BiMap<string, Worker>();
	const worker_promises = new WeakMap<Worker, (value: void | PromiseLike<void>) => void>();

	const peer_id = options.id ?? 'main';
	const response_timeout = options.response_timeout ?? RESPONSE_TIMEOUT_MS;

	const auto_restart_enabled = options.auto_restart !== undefined && options.auto_restart !== false;
	const auto_restart_config = typeof options.auto_restart === 'object' ? options.auto_restart : {};
	const backoff_max = auto_restart_config.backoff_max ?? 5 * 60 * 1000; // 5 min
	const backoff_grace = auto_restart_config.backoff_grace ?? 30000; // 30 seconds
	const max_attempts = auto_restart_config.max_attempts ?? 5;

	const worker_states = new WeakMap<Worker, WorkerState>();

	const worker_paths: string[] = options.size !== undefined
		? Array(options.size).fill(options.worker)
		: Array.isArray(options.worker) ? options.worker : [options.worker];

	log_worker(`created worker pool {${peer_id}}`);

	const callbacks = new Map<string, (data: WorkerMessage) => Promise<void> | void>();
	const pending_responses = new Map<string, { resolve: (message: WorkerMessage) => void, reject: (error: Error) => void, timeout: Timer | undefined }>();

	const on_worker_start = options.onWorkerStart;
	const on_worker_stop = options.onWorkerStop;

	async function restart_worker(worker: Worker) {
		if (!auto_restart_enabled)
			return;

		const state = worker_states.get(worker);
		if (!state)
			return;

		if (state.restart_success_timer) {
			clearTimeout(state.restart_success_timer);
			state.restart_success_timer = null;
		}

		if (max_attempts !== -1 && state.restart_attempts >= max_attempts) {
			log_worker(`worker {${state.worker_id ?? 'unknown'}} maximum restart attempts ({${max_attempts}}) reached, stopping auto-restart`);
			return;
		}

		state.restart_attempts++;
		const current_delay = Math.min(state.restart_delay, backoff_max);
		const max_attempt_str = max_attempts === -1 ? '∞' : max_attempts;

		log_worker(`restarting worker {${state.worker_id ?? 'unknown'}} in {${current_delay}ms} (attempt {${state.restart_attempts}}/{${max_attempt_str}}, delay capped at {${backoff_max}ms})`);

		setTimeout(() => {
			const new_worker = new Worker(state.worker_path);

			state.worker = new_worker;
			state.restart_delay = Math.min(state.restart_delay * 2, backoff_max);

			state.restart_success_timer = setTimeout(() => {
				state.restart_delay = 100;
				state.restart_attempts = 0;
				state.restart_success_timer = null;
			}, backoff_grace);

			worker_states.delete(worker);
			worker_states.set(new_worker, state);

			setup_worker_listeners(new_worker);
		}, current_delay);
	}

	function setup_worker_listeners(worker: Worker) {
		worker.addEventListener('message', (event) => {
			handle_worker_message(worker, event);
		});

		worker.addEventListener('close', (event: CloseEvent) => {
			const worker_id = pipe_workers.getByValue(worker);
			const exit_code = event.code;
			log_worker(`worker {${worker_id ?? 'unknown'}} closed, exit code {${exit_code}}`);

			if (worker_id)
				pipe_workers.deleteByKey(worker_id);

			if (worker_id)
				on_worker_stop?.(pool, worker_id, exit_code);

			if (auto_restart_enabled && exit_code !== WORKER_EXIT_NO_RESTART)
				restart_worker(worker);
			else if (exit_code === WORKER_EXIT_NO_RESTART)
				log_worker(`worker {${worker_id ?? 'unknown'}} exited with {WORKER_EXIT_NO_RESTART}, skipping auto-restart`);
		});
	}

	function handle_worker_message(worker: Worker, event: MessageEvent) {
		const message = event.data as WorkerMessage;

		if (message.id === '__register__') {
			const worker_id = message.data?.worker_id;
			if (worker_id === undefined) {
				log_error('cannot register worker without ID');
				return;
			}

			if (pipe_workers.hasKey(worker_id)) {
				log_error(`worker ID {${worker_id}} already in-use`);
				return;
			}

			pipe_workers.set(message.data?.worker_id, worker);

			const state = worker_states.get(worker);
			if (state)
				state.worker_id = worker_id;

			worker_promises.get(worker)?.();
			worker_promises.delete(worker);

			on_worker_start?.(pool, worker_id);
		} else if (message.peer === '__broadcast__') {
			const worker_id = pipe_workers.getByValue(worker);
			if (worker_id === undefined)
				return;

			message.peer = worker_id;
			callbacks.get(message.id)?.(message);

			for (const target_worker of pipe_workers.values()) {
				if (target_worker === worker)
					continue;

				target_worker.postMessage(message);
			}
		} else {
			const target_peer = message.peer;
			const target_worker = pipe_workers.getByKey(target_peer);
			const worker_id = pipe_workers.getByValue(worker);

			if (worker_id === undefined)
				return;

			message.peer = worker_id;

			if (target_peer === peer_id) {
				if (message.response_to && pending_responses.has(message.response_to)) {
					const pending = pending_responses.get(message.response_to)!;
					if (pending.timeout)
						clearTimeout(pending.timeout);

					pending_responses.delete(message.response_to);
					pending.resolve(message);
					return;
				}

				callbacks.get(message.id)?.(message);
			}

			target_worker?.postMessage(message);
		}
	}

	const pool: WorkerPool = {
		id: peer_id,

		send(peer: string, id: string, data?: WorkerMessageData, expect_response?: boolean): any {
			const message: WorkerMessage = { id, peer: peer_id, data, uuid: Bun.randomUUIDv7() };

			if (expect_response) {
				return new Promise<WorkerMessage>((resolve, reject) => {
					let timeout: Timer | undefined;

					if (response_timeout !== -1) {
						timeout = setTimeout(() => {
							pending_responses.delete(message.uuid);
							reject(new Error(`Response timeout after ${response_timeout}ms`));
						}, response_timeout);
					}

					pending_responses.set(message.uuid, { resolve, reject, timeout });

					const target_worker = pipe_workers.getByKey(peer);
					target_worker?.postMessage(message);
				});
			} else {
				const target_worker = pipe_workers.getByKey(peer);
				target_worker?.postMessage(message);
			}
		},

		broadcast: (id: string, data?: WorkerMessageData) => {
			const message: WorkerMessage = { peer: peer_id, id, data, uuid: Bun.randomUUIDv7() };
			
			for (const target_worker of pipe_workers.values())
				target_worker.postMessage(message);
		},

		respond: (message: WorkerMessage, data?: WorkerMessageData) => {
			const response: WorkerMessage = {
				id: message.id,
				peer: peer_id,
				data,
				uuid: Bun.randomUUIDv7(),
				response_to: message.uuid
			};

			const target_worker = pipe_workers.getByKey(message.peer);
			target_worker?.postMessage(response);
		},

		on: (event: string, callback: (data: WorkerMessage) => Promise<void> | void) => {
			callbacks.set(event, callback);
		},

		off: (event: string) => {
			callbacks.delete(event);
		},

		once: (event: string, callback: (data: WorkerMessage) => Promise<void> | void) => {
			callbacks.set(event, async (data: WorkerMessage) => {
				await callback(data);
				callbacks.delete(event);
			});
		}
	};

	const promises = [];
	for (const path of worker_paths) {
		const worker = new Worker(path);

		if (auto_restart_enabled) {
			worker_states.set(worker, {
				worker,
				restart_delay: 100,
				restart_attempts: 0,
				restart_success_timer: null,
				worker_path: path
			});
		}

		setup_worker_listeners(worker);

		promises.push(new Promise<void>(resolve => {
			worker_promises.set(worker, resolve);
		}));
	}

	await Promise.all(promises);

	return pool;
}

export function worker_connect(peer_id?: string, response_timeout?: number): WorkerPool {
	const listeners = new Map<string, (message: WorkerMessage) => Promise<void> | void>();
	const pending_responses = new Map<string, { resolve: (message: WorkerMessage) => void, reject: (error: Error) => void, timeout: Timer | undefined }>();

	if (peer_id === undefined) {
		// normally we would increment 'worker1', 'worker2' etc but we
		// have no simple way of keeping track of global worker count.

		// in normal circumstances, users should provide an ID via the
		// parameter, this is just a sensible fallback.
		peer_id = 'worker-' + Bun.randomUUIDv7();
	}

	response_timeout = response_timeout ?? RESPONSE_TIMEOUT_MS;

	log_worker(`worker {${peer_id}} connected to pool`);

	const worker = globalThis as unknown as Worker;
	worker.onmessage = event => {
		const message = event.data as WorkerMessage;

		if (message.response_to && pending_responses.has(message.response_to)) {
			const pending = pending_responses.get(message.response_to)!;
			if (pending.timeout)
				clearTimeout(pending.timeout);

			pending_responses.delete(message.response_to);
			pending.resolve(message);
			return;
		}

		listeners.get(message.id)?.(message);
	};

	worker.postMessage({
		id: '__register__',
		data: {
			worker_id: peer_id
		}
	});

	return {
		id: peer_id,

		send(peer: string, id: string, data?: WorkerMessageData, expect_response?: boolean): any {
			const message: WorkerMessage = { id, peer, data, uuid: Bun.randomUUIDv7() };

			if (expect_response) {
				return new Promise<WorkerMessage>((resolve, reject) => {
					let timeout: Timer | undefined;

					if (response_timeout !== -1) {
						timeout = setTimeout(() => {
							pending_responses.delete(message.uuid);
							reject(new Error(`Response timeout after ${response_timeout}ms`));
						}, response_timeout);
					}

					pending_responses.set(message.uuid, { resolve, reject, timeout });
					worker.postMessage(message);
				});
			} else {
				worker.postMessage(message);
			}
		},

		broadcast: (id: string, data?: WorkerMessageData) => {
			const message: WorkerMessage = { peer: '__broadcast__', id, data, uuid: Bun.randomUUIDv7() };
			worker.postMessage(message);
		},

		respond: (message: WorkerMessage, data?: WorkerMessageData) => {
			const response: WorkerMessage = {
				id: message.id,
				peer: message.peer,
				data,
				uuid: Bun.randomUUIDv7(),
				response_to: message.uuid
			};

			worker.postMessage(response);
		},

		on: (event: string, callback: (message: WorkerMessage) => Promise<void> | void) => {
			listeners.set(event, callback);
		},

		off: (event: string) => {
			listeners.delete(event);
		},

		once: (event: string, callback: (message: WorkerMessage) => Promise<void> | void) => {
			listeners.set(event, async (message: WorkerMessage) => {
				await callback(message);
				listeners.delete(event);
			});
		}
	};
}

// endregion

// region utility
export class BiMap<K, V> {
	private ktv = new Map<K, V>();
	private vtk = new Map<V, K>();

	set(key: K, value: V): void {
		const old_val = this.ktv.get(key);
		if (old_val !== undefined)
			this.vtk.delete(old_val);

		const old_key = this.vtk.get(value);
		if (old_key !== undefined)
			this.ktv.delete(old_key);

		this.ktv.set(key, value);
		this.vtk.set(value, key);
	}

	getByKey(key: K): V | undefined {
		return this.ktv.get(key);
	}

	getByValue(value: V): K | undefined {
		return this.vtk.get(value);
	}

	hasKey(key: K): boolean {
		return this.ktv.has(key);
	}

	hasValue(value: V): boolean {
		return this.vtk.has(value);
	}

	deleteByKey(key: K): boolean {
		const value = this.ktv.get(key);
		if (value === undefined)
			return false;

		this.ktv.delete(key);
		this.vtk.delete(value);
		return true;
	}

	deleteByValue(value: V): boolean {
		const key = this.vtk.get(value);
		if (key === undefined)
			return false;

		this.vtk.delete(value);
		this.ktv.delete(key);
		return true;
	}

	clear(): void {
		this.ktv.clear();
		this.vtk.clear();
	}

	get size(): number {
		return this.ktv.size;
	}

	entries(): IterableIterator<[K, V]> {
		return this.ktv.entries();
	}

	keys(): IterableIterator<K> {
		return this.ktv.keys();
	}

	values(): IterableIterator<V> {
		return this.ktv.values();
	}

	[Symbol.iterator](): IterableIterator<[K, V]> {
		return this.ktv.entries();
	}
}

const FILESIZE_UNITS = ['bytes', 'kb', 'mb', 'gb', 'tb'];

export function filesize(bytes: number): string {
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
	
	return (strings: TemplateStringsArray | string, ...values: any[]) => {
		if (typeof strings === 'string') {
			// regular string with { } syntax
			console.log(prefix + strings.replace(/\{([^}]+)\}/g, `${ansi}$1\x1b[0m`), ...values);
		} else {
			// tagged template literal
			let message = '';
			for (let i = 0; i < strings.length; i++) {
				message += strings[i];
				if (i < values.length)
					message += `${ansi}${values[i]}\x1b[0m`;
			}
			console.log(prefix + message);
		}
	};
}

export function log_list(input: any[], delimiter = ',') {
	return input.map(e => `{${e}}`).join(delimiter);
}

const log_spooder = log_create_logger('spooder', 'spooder');
export const log = log_create_logger('info', 'blue');
export const log_error = log_create_logger('error', 'red');

// endregion

// region spooder ipc
export const IPC_OP = {
	CMSG_TRIGGER_UPDATE: -1,
	SMSG_UPDATE_READY: -2,
	CMSG_REGISTER_LISTENER: -3,
};

// internal targets should always use __X__ as this format is
// reserved; userland instances cannot be named this way
export const IPC_TARGET = {
	SPOODER: '__spooder__',
	BROADCAST: '__broadcast__'
};

type IPC_Callback = (data: IPC_Message) => void;
type IPC_Message = {
	op: number;
	peer: string;
	data?: object
};

let ipc_fail_announced = false;
let ipc_listener_attached = false;

const ipc_listeners = new Map<number, Set<IPC_Callback>>();

function ipc_on_message(payload: IPC_Message) {
	const listeners = ipc_listeners.get(payload.op);
	if (!listeners)
		return;

	for (const callback of listeners)
		callback(payload);
}

export function ipc_send(peer: string, op: number, data?: object) {
	if (!process.send) {
		if (!ipc_fail_announced) {
			log_spooder(`{ipc_send} failed, process not spawned with ipc channel`);
			caution('ipc_send failed', { e: 'process not spawned with ipc channel' });
			ipc_fail_announced = true;
		}

		return;
	}

	process.send({ peer, op, data });
}

export function ipc_register(op: number, callback: IPC_Callback) {
	if (!ipc_listener_attached) {
		process.on('message', ipc_on_message);
		ipc_listener_attached = true;
	}

	const listeners = ipc_listeners.get(op);
	if (listeners)
		listeners.add(callback);
	else
		ipc_listeners.set(op, new Set([callback]));

	ipc_send(IPC_TARGET.SPOODER, IPC_OP.CMSG_REGISTER_LISTENER, { op });
}
// endregion

// region cache
type CacheOptions = {
	ttl?: number;
	max_size?: number;
	use_etags?: boolean;
	headers?: Record<string, string>,
	use_canary_reporting?: boolean;
	enabled?: boolean;
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
	const enabled = options?.enabled ?? true;
	
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
					
					if (enabled)
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
				
				if (enabled)
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
		log_spooder('[{dev}] %O', final_err);
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
type ReplacerFn = (key: string, value?: string) => string | Array<string> | undefined;
type AsyncReplaceFn = (key: string, value?: string) => Promise<string | Array<string> | undefined>;
type ReplacementValueFn = () => string | Array<string> | undefined;
type AsyncReplacementValueFn = () => Promise<string | Array<string> | undefined>;
type ReplacementValueWithKeyFn = (value?: string) => string | Array<string> | undefined;
type AsyncReplacementValueWithKeyFn = (value?: string) => Promise<string | Array<string> | undefined>;
type ReplacementValue = string | Array<string> | object | object[] | ReplacementValueFn | AsyncReplacementValueFn | ReplacementValueWithKeyFn | AsyncReplacementValueWithKeyFn;
type Replacements = Record<string, ReplacementValue> | ReplacerFn | AsyncReplaceFn;

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
			let loop_entries = is_replacer_fn ? await replacements(entries_key) : replacements[entries_key];

			if (loop_entries !== undefined) {
				if (typeof loop_entries === 'function')
					loop_entries = await loop_entries();

				if (Array.isArray(loop_entries)) {
					let loop_result = '';
					for (const loop_entry of loop_entries) {
						let scoped_replacements: Replacements;
						
						if (typeof replacements === 'function') {
							scoped_replacements = async (key: string) => {
								if (key === alias_name)
									return loop_entry;

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
				}
			}

			if (!drop_missing)
				return match;

			return '';
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
			
			// Check for key=value syntax
			let key = var_name;
			let value: string | undefined = undefined;
			const equals_index = var_name.indexOf('=');

			if (equals_index !== -1) {
				key = var_name.substring(0, equals_index);
				value = var_name.substring(equals_index + 1);
			}
			
			let replacement;
			
			if (is_replacer_fn) {
				replacement = await replacements(key, value);
			} else {
				// First try direct key lookup (handles hash keys with dots like "hash=.gitignore")
				replacement = replacements[var_name];
				
				// If direct lookup fails and we have key=value syntax, try key lookup
				if (replacement === undefined && value !== undefined) {
					replacement = replacements[key];
				}
				
				// If still undefined and variable contains dots, try nested property access
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
			
			if (replacement !== undefined && typeof replacement === 'function') {
				if (value !== undefined && replacement.length > 0)
					replacement = await replacement(value);
				else
					replacement = await replacement();
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
// endregion

// region cache busting
let cache_bust_map: Record<string, string> | null = null;
let cache_bust_global_length = 7;
let cache_bust_global_format = '$file?v=$hash';

export function cache_bust_get_hash_table(): Record<string, string> {
	if (cache_bust_map === null)
		cache_bust_map = git_get_hashes_sync(cache_bust_global_length);

	return cache_bust_map;
}

export function cache_bust(paths: string|string[], format = cache_bust_global_format): string|string[] {
	const hash_table = cache_bust_get_hash_table();

	if (Array.isArray(paths)) {
		const n_paths = paths.length;
		const result = Array<string>(n_paths);

		for (let i = 0; i < n_paths; i++) {
			const path = paths[i];
			const hash = hash_table[path] ?? '';

			result[i] = format.replace('$file', path).replace('$hash', hash);
		}

		return result;
	} else {
		const hash = cache_bust_get_hash_table()[paths] ?? '';
		return format.replace('$file', paths).replace('$hash', hash);
	}
}

export function cache_bust_set_hash_length(length: number): void {
	cache_bust_global_length = length;
}

export function cache_bust_set_format(format: string): void {
	cache_bust_global_format = format;
}
// endregion

// region git
export async function git_get_hashes(length = 7): Promise<Record<string, string>> {
	const cmd = ['git', 'ls-tree', '-r', 'HEAD'];
	const process = Bun.spawn(cmd, {
		stdout: 'pipe',
		stderr: 'pipe'
	});
	
	await process.exited;
	
	if (process.exitCode as number > 0)
		return {};
	
	const stdout = await Bun.readableStreamToText(process.stdout as ReadableStream);
	const hash_map: Record<string, string> = {};
	
	const regex = /([^\s]+)\s([^\s]+)\s([^\s]+)\t(.+)/g;
	let match: RegExpExecArray | null;
	
	while (match = regex.exec(stdout))
		hash_map[match[4]] = match[3].substring(0, length);
	
	return hash_map;
}

export function git_get_hashes_sync(length = 7): Record<string, string> {
	const cmd = ['git', 'ls-tree', '-r', 'HEAD'];
	const process = Bun.spawnSync(cmd, {
		stdout: 'pipe',
		stderr: 'pipe'
	});
	
	if (process.exitCode > 0)
		return {};
	
	const stdout = process.stdout.toString();
	const hash_map: Record<string, string> = {};
	
	const regex = /([^\s]+)\s([^\s]+)\s([^\s]+)\t(.+)/g;
	let match: RegExpExecArray | null;
	
	while (match = regex.exec(stdout))
		hash_map[match[4]] = match[3].substring(0, length);
	
	return hash_map;
}
// endregion

// region cookies
const cookie_map = new WeakMap<Request, Bun.CookieMap>();

export function cookies_get(req: Request): Bun.CookieMap {
	let jar = cookie_map.get(req);
	if (jar !== undefined)
		return jar;

	jar = new Bun.CookieMap(req.headers.get('Cookie') ?? undefined);
	cookie_map.set(req, jar);
	return jar;
}

function apply_cookies(req: Request, res: Response) {
	const jar = cookie_map.get(req);
	if (jar === undefined)
		return;

	const cookies = jar.toSetCookieHeaders();
	for (const cookie of cookies)
		res.headers.append('Set-Cookie', cookie);
}
// endregion

// region serving
export const HTTP_STATUS_TEXT: Record<number, string> = {
	// 1xx Informational Response
	100: 'Continue',
	101: 'Switching Protocols',
	102: 'Processing',
	103: 'Early Hints',
	
	// 2xx Success
	200: 'OK',
	201: 'Created',
	202: 'Accepted',
	203: 'Non-Authoritative Information',
	204: 'No Content',
	205: 'Reset Content',
	206: 'Partial Content',
	207: 'Multi-Status',
	208: 'Already Reported',
	226: 'IM Used',
	
	// 3xx Redirection
	300: 'Multiple Choices',
	301: 'Moved Permanently',
	302: 'Found',
	303: 'See Other',
	304: 'Not Modified',
	305: 'Use Proxy',
	307: 'Temporary Redirect',
	308: 'Permanent Redirect',
	
	// 4xx Client Errors
	400: 'Bad Request',
	401: 'Unauthorized',
	403: 'Forbidden',
	404: 'Not Found',
	405: 'Method Not Allowed',
	406: 'Not Acceptable',
	407: 'Proxy Authentication Required',
	408: 'Request Timeout',
	409: 'Conflict',
	410: 'Gone',
	411: 'Length Required',
	412: 'Precondition Failed',
	413: 'Payload Too Large',
	414: 'URI Too Long',
	415: 'Unsupported Media Type',
	416: 'Range Not Satisfiable',
	417: 'Expectation Failed',
	418: 'I\'m a Teapot',
	421: 'Misdirected Request',
	422: 'Unprocessable Content',
	423: 'Locked',
	424: 'Failed Dependency',
	425: 'Too Early',
	426: 'Upgrade Required',
	428: 'Precondition Required',
	429: 'Too Many Requests',
	431: 'Request Header Fields Too Large',
	451: 'Unavailable For Legal Reasons',
	
	// 5xx Server Errors
	500: 'Internal Server Error',
	501: 'Not Implemented',
	502: 'Bad Gateway',
	503: 'Service Unavailable',
	504: 'Gateway Timeout',
	505: 'HTTP Version Not Supported',
	506: 'Variant Also Negotiates',
	507: 'Insufficient Storage',
	508: 'Loop Detected',
	510: 'Not Extended',
	511: 'Network Authentication Required'
};

export const HTTP_STATUS_CODE = {
	// 1xx Informational Response
	Continue_100: 100,
	SwitchingProtocols_101: 101,
	Processing_102: 102,
	EarlyHints_103: 103,
	
	// 2xx Success
	OK_200: 200,
	Created_201: 201,
	Accepted_202: 202,
	NonAuthoritativeInformation_203: 203,
	NoContent_204: 204,
	ResetContent_205: 205,
	PartialContent_206: 206,
	MultiStatus_207: 207,
	AlreadyReported_208: 208,
	IMUsed_226: 226,
	
	// 3xx Redirection
	MultipleChoices_300: 300,
	MovedPermanently_301: 301,
	Found_302: 302,
	SeeOther_303: 303,
	NotModified_304: 304,
	UseProxy_305: 305,
	TemporaryRedirect_307: 307,
	PermanentRedirect_308: 308,
	
	// 4xx Client Errors
	BadRequest_400: 400,
	Unauthorized_401: 401,
	Forbidden_403: 403,
	NotFound_404: 404,
	MethodNotAllowed_405: 405,
	NotAcceptable_406: 406,
	ProxyAuthenticationRequired_407: 407,
	RequestTimeout_408: 408,
	Conflict_409: 409,
	Gone_410: 410,
	LengthRequired_411: 411,
	PreconditionFailed_412: 412,
	PayloadTooLarge_413: 413,
	URITooLong_414: 414,
	UnsupportedMediaType_415: 415,
	RangeNotSatisfiable_416: 416,
	ExpectationFailed_417: 417,
	ImATeapot_418: 418,
	MisdirectedRequest_421: 421,
	UnprocessableContent_422: 422,
	Locked_423: 423,
	FailedDependency_424: 424,
	TooEarly_425: 425,
	UpgradeRequired_426: 426,
	PreconditionRequired_428: 428,
	TooManyRequests_429: 429,
	RequestHeaderFieldsTooLarge_431: 431,
	UnavailableForLegalReasons_451: 451,
	
	// 5xx Server Errors
	InternalServerError_500: 500,
	NotImplemented_501: 501,
	BadGateway_502: 502,
	ServiceUnavailable_503: 503,
	GatewayTimeout_504: 504,
	HTTPVersionNotSupported_505: 505,
	VariantAlsoNegotiates_506: 506,
	InsufficientStorage_507: 507,
	LoopDetected_508: 508,
	NotExtended_510: 510,
	NetworkAuthenticationRequired_511: 511
} as const;

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
			
			file = file.slice(
				start_is_nan ? file.size - end : start,
				end_is_nan || start_is_nan ? undefined : end + 1
			);
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


function route_directory(route_path: string, dir: string, handler_or_options: DirHandler | DirOptions): RequestHandler {
	const is_handler = typeof handler_or_options === 'function';
	const handler = is_handler ? handler_or_options as DirHandler : null;
	const default_options = { ignore_hidden: true, index_directories: false, support_ranges: true };
	const options = is_handler ? default_options : { ...default_options, ...handler_or_options as DirOptions };
	
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
	accept?: (req: Request, url: URL) => WebsocketAcceptReturn | Promise<WebsocketAcceptReturn>,
	message?: (ws: WebSocket, message: string | Buffer) => void,
	message_json?: (ws: WebSocket, message: JsonSerializable) => void,
	open?: (ws: WebSocket) => void,
	close?: (ws: WebSocket, code: number, reason: string) => void,
	drain?: (ws: WebSocket) => void
};

type BootstrapSub = ReplacementValue;

type BootstrapRoute = {
	content: string | BunFile;
	subs?: Record<string, BootstrapSub>;
};

type BootstrapCacheBust = {
	prefix?: string;
	hash_length?: number;
	format?: string;
};

type BootstrapOptions = {
	base?: string | BunFile;
	drop_missing_subs?: boolean;

	routes: Record<string, BootstrapRoute>;
	cache?: ReturnType<typeof cache_http> | CacheOptions;

	cache_bust?: boolean | BootstrapCacheBust;

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
			
			return new Response(HTTP_STATUS_TEXT[500], { status: 500 });
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

			apply_cookies(req, response);
			
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
	
	type ThrottleHandler = {
		(delta: number, handler: JSONRequestHandler): JSONRequestHandler;
		(delta: number, handler: RequestHandler): RequestHandler;
	};

	return {
		/** Register a handler for a specific route. */
		route: (path: string, handler: RequestHandler, method: HTTP_METHODS = 'GET'): void => {
			if (path.length > 1 && path.endsWith('/'))
				path = path.slice(0, -1);
			routes.push([path.split('/'), handler, method]);
		},

		/** Throttles an endpoint to take at least the specified delta time (in ms) */
		throttle: ((delta: number, handler: JSONRequestHandler | RequestHandler): any => {
			return async (req: Request, ...args: any[]) => {
				const t_start = Date.now();
				const result = await (handler as any)(req, ...args);

				const t_elapsed = Date.now() - t_start;
				const t_remaining = Math.max(0, delta - t_elapsed);

				if (t_remaining > 0)
					await Bun.sleep(t_remaining);

				slow_requests.add(req);
				return result;
			};
		}) as ThrottleHandler,
		
		/** Register a JSON endpoint with automatic content validation. */
		json: (path: string, handler: JSONRequestHandler, method: HTTP_METHODS = 'POST'): void => {
			const json_wrapper: RequestHandler = async (req: Request, url: URL) => {
				// handle CORS preflight
				if (req.method === 'OPTIONS') {
					return new Response(null, {
						status: 204,
						headers: {
							'Access-Control-Allow-Origin': '*',
							'Access-Control-Allow-Methods': `${Array.isArray(method) ? method.join(', ') : method}, OPTIONS`,
							'Access-Control-Allow-Headers': 'Content-Type, User-Agent'
						}
					});
				}

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

			const methods: HTTP_METHODS = Array.isArray(method) ? [...method, 'OPTIONS'] : [method, 'OPTIONS'];
			routes.push([path.split('/'), json_wrapper, methods]);
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
			
			const final_handler_or_options = handler_or_options ?? { ignore_hidden: true, index_directories: false, support_ranges: true };
			routes.push([[...path.split('/'), '*'], route_directory(path, dir, final_handler_or_options), method]);
		},
		
		/** Add a route to upgrade connections to websockets. */
		websocket: (path: string, handlers: WebsocketHandlers): void => {
			routes.push([path.split('/'), async (req: Request, url: URL) => {
				let context_data = undefined;
				if (handlers.accept) {
					const res = await handlers.accept(req, url);
					
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
		
		webhook: (secret: string, path: string, handler: WebhookHandler, branches?: string | string[]): void => {
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
				
				// Branch filtering logic
				if (branches !== undefined) {
					const branch_list = Array.isArray(branches) ? branches : [branches];
					const payload = body as any;
					
					if (payload.ref && typeof payload.ref === 'string') {
						const branch_name = payload.ref.split('/').pop() || payload.ref;
						
						if (!branch_list.includes(branch_name))
							return 200; // OK
					}
				}
				
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
			let cache_bust_subs: Record<string, ReplacementValue> = {};
			
			const cache_bust_opts = options.cache_bust;
			if (typeof cache_bust_opts === 'object' && cache_bust_opts !== null) {
				if (typeof cache_bust_opts.hash_length === 'number')
					cache_bust_set_hash_length(cache_bust_opts.hash_length);

				if (typeof cache_bust_opts.format === 'string')
					cache_bust_set_format(cache_bust_opts.format);

				cache_bust_subs[cache_bust_opts.prefix ?? 'cache_bust'] = cache_bust;
			} else if (cache_bust_opts === true) {
				cache_bust_subs = { cache_bust };
			}
			
			const global_sub_table = sub_table_merge(cache_bust_subs, options.global_subs);

			let cache = options.cache;
			if (cache !== undefined && !is_cache_http(cache))
				cache = cache_http(cache);

			const drop_missing = options.drop_missing_subs ?? true;
			for (const [route, route_opts] of Object.entries(options.routes)) {
				const content_generator = async () => {
					let content = await resolve_bootstrap_content(route_opts.content);

					if (options.base !== undefined)
						content = await parse_template(await resolve_bootstrap_content(options.base), { content }, false);
					
					const sub_table = sub_table_merge({}, global_sub_table, route_opts.subs);
					content = await parse_template(content, sub_table, drop_missing);
					
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
					const error_text = HTTP_STATUS_TEXT[status_code] as string;
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
						return new Response(content, {
							status: status_code,
							headers: {
								'content-type': 'text/html'
							}
						});
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

					if (static_options.sub_ext?.some(ext => file_path.endsWith(ext))) {
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

// region db
type SchemaOptions = {
	schema_table?: string;
	recursive?: boolean;
};

type TableRevision = {
	revision_number: number;
	file_path: string;
	filename: string;
};

const db_log = log_create_logger('db', 'spooder');

export function db_set_cast<T extends string>(set: string | null): Set<T> {
	return new Set(set?.split(',') as T[] ?? []);
}

export function db_set_serialize<T extends string>(set: Iterable<T> | null): string {
	return set ? Array.from(set).join(',') : '';
}

export async function db_exists(db: SQL, table_name: string, value: string|number, column_name = 'id'): Promise<boolean> {
	const rows = await db`SELECT 1 FROM ${db(table_name)} WHERE ${db(column_name)} = ${value} LIMIT 1`;
	return rows.length > 0;
}

export async function db_get_schema_revision(db: SQL): Promise<number|null> {
	try {
		const [result] = await db`SELECT MAX(revision_number) as latest_revision FROM db_schema`;
		return result.latest_revision ?? 0;
	} catch (e) {
		return null;
	}
}

export async function db_schema(db: SQL, schema_path: string, options?: SchemaOptions): Promise<boolean> {
	const schema_table = options?.schema_table ?? 'db_schema';
	const recursive = options?.recursive ?? true;

	db_log`applying schema revisions from ${schema_path}`;
	let current_revision = await db_get_schema_revision(db);

	if (current_revision === null) {
		db_log`initiating schema database table ${schema_table}`;
		await db`CREATE TABLE ${db(schema_table)} (
			revision_number INTEGER PRIMARY KEY,
			filename VARCHAR(255) NOT NULL,
			applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
		);`;
	}

	current_revision ??= 0;

	const revisions = Array<TableRevision>();
	const files = await fs.readdir(schema_path, { recursive, encoding: 'utf8' });
	for (const file of files) {
		const filename = path.basename(file);
		if (!filename.toLowerCase().endsWith('.sql'))
			continue;
		
		const match = filename.match(/^(\d+)/);
		const revision_number = match ? Number(match[1]) : null;
		if (revision_number === null || revision_number < 1) {
			log_error`skipping sql file ${file}, invalid revision number`;
			continue;
		}

		const file_path = path.join(schema_path, file);
		if (revision_number > current_revision) {
			revisions.push({
				revision_number,
				file_path,
				filename
			});
		}
	}

	// sort revisions in ascending order before applying
	// for recursive trees or unreliable OS sort ordering
	revisions.sort((a, b) => a.revision_number - b.revision_number);

	const revisions_applied = Array<string>();
	for (const rev of revisions) {
		db_log`applying revision ${rev.revision_number} from ${rev.filename}`;
		
		try {
			await db.begin(async tx => {
				await tx.file(rev.file_path);
				await tx`INSERT INTO ${db(schema_table)} ${db(rev, 'revision_number', 'filename')}`;
				revisions_applied.push(rev.filename);
			});
		} catch (err) {
			
			log_error`failed to apply revisions from ${rev.filename}: ${err}`;
			log_error`${'warning'}: if ${rev.filename} contained DDL statements, they will ${'not'} be rolled back automatically`;
			log_error`verify the current database state ${'before'} running ammended revisions`;
			
			const last_revision = await db_get_schema_revision(db);
			db_log`database schema revision is now ${last_revision ?? 0}`;

			caution('db_schema failed', { rev, err, last_revision, revisions_applied });

			return false;
		}
	}

	if (revisions_applied.length > 0) {
		const new_revision = await db_get_schema_revision(db);
		db_log`applied ${revisions_applied.length} database schema revisions (${current_revision} >> ${new_revision})`;
	} else {
		db_log`no database schema revisions to apply (current: ${current_revision})`;
	}

	return true;
}
// endregion