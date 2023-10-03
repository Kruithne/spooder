import { get_config } from './config';
import { create_github_issue } from './github';
import { log } from './utils';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

async function load_local_env(): Promise<Map<string, string>> {
	const env = new Map<string, string>();

	const env_file = Bun.file(path.join(process.cwd(), '.env.local'));

	if (env_file.size > 0) {
		const env_text = await env_file.text();
		const env_lines = env_text.split(/\r?\n/);

		for (const line of env_lines) {
			// Empty lines / comments
			if (line.length === 0 || line.startsWith('#'))
				continue;

			const separator_index = line.indexOf('=');
			if (separator_index === -1)
				continue;

			const key = line.slice(0, separator_index).trim();
			let value = line.slice(separator_index + 1).trim();

			// Strip quotes.
			if (value.startsWith('"') && value.endsWith('"'))
				value = value.slice(1, -1);
			else if (value.startsWith("'") && value.endsWith("'"))
				value = value.slice(1, -1);

			env.set(key, value);
		}
	}

	return env;
}

async function save_cache_table(table: Map<bigint, number>, cache_file_path: string): Promise<void> {
	const data = Buffer.alloc(4 + (table.size * 12));

	let offset = 4;
	data.writeUInt32LE(table.size, 0);

	for (const [key, value] of table.entries()) {
		data.writeBigUint64LE(key, offset);
		offset += 8;

		data.writeUInt32LE(value, offset);
		offset += 4;
	}

	await new Promise(resolve => fs.mkdir(path.dirname(cache_file_path), { recursive: true }, resolve));
	await Bun.write(cache_file_path, data);
}

async function check_cache_table(key: string, repository: string, expiry: number): Promise<boolean> {
	if (expiry === 0)
		return false;

	const [owner, repo] = repository.split('/');
	const cache_file_path = path.join(os.tmpdir(), 'spooder_canary', owner, repo, 'cache.bin');

	const cache_table = new Map<bigint, number>();
	const key_hash = BigInt(Bun.hash.wyhash(key));

	const time_now = Math.floor(Date.now() / 1000);
	const expiry_threshold = time_now - expiry;

	let changed = false;
	try {
		const cache_file = Bun.file(cache_file_path);
		
		if (cache_file.size > 0) {
			const data = Buffer.from(await cache_file.arrayBuffer());
			const entry_count = data.readUInt32LE(0);

			let offset = 4;
			for (let i = 0; i < entry_count; i++) {
				const hash = data.readBigUInt64LE(offset);
				offset += 8;

				const expiry = data.readUInt32LE(offset);
				offset += 4;
			
				if (expiry >= expiry_threshold)
					cache_table.set(hash, expiry);
				else
					changed = true;
			}
		}
	} catch (e) {
		log('failed to read canary cache file ' + cache_file_path);
		log('error: ' + (e as Error).message);
		log('you should resolve this issue to prevent spamming GitHub with canary reports');
	}

	if (cache_table.has(key_hash)) {
		if (changed)
			await save_cache_table(cache_table, cache_file_path);

		return true;
	}

	cache_table.set(key_hash, time_now);
	await save_cache_table(cache_table, cache_file_path);

	return false;
}

function sanitize_string(input: string, local_env?: Map<string, string>): string {
	// Strip all potential e-mail addresses.
	input = input.replaceAll(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/g, '[e-mail address]');

	// Strip IPv4 addresses.
	input = input.replaceAll(/([0-9]{1,3}\.){3}[0-9]{1,3}/g, '[IPv4 address]');

	// Strip IPv6 addresses.
	input = input.replaceAll(/([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}/g, '[IPv6 address]');

	// Strip local environment variables.
	if (local_env !== undefined) {
		// Do not expose the name of the key redacted, as this may inadvertently expose the key/value
		// if the value coincidentally appears in some other context.
		for (const value of local_env.values())
			input = input.replaceAll(value, '[redacted]');
	}

	return input;
}

function generate_diagnostics(): object {
	return {
		'loadavg': os.loadavg(),
		'memory': {
			'free': os.freemem(),
			'total': os.totalmem(),
		},
		'platform': os.platform(),
		'uptime': os.uptime(),
		'versions': process.versions,
		'bun': {
			'version': Bun.version,
			'rev': Bun.revision,
			'memory_usage': process.memoryUsage(),
			'cpu_usage': process.cpuUsage()
		}
	}
}

export async function dispatch_report(report_title: string, report_body: Array<unknown>): Promise<void> {
	try {
		const config = await get_config();

		const canary_account = config.canary.account;
		const canary_repostiory = config.canary.repository;

		if (canary_account.length === 0|| canary_repostiory.length === 0) {
			log('[canary] report dispatch failed; no account/repository configured');
			return;
		}

		const is_cached = await check_cache_table(report_title, canary_repostiory, config.canary.throttle);
		if (is_cached) {
			log('[canary] throttled canary report: ' + report_title);
			return;
		}

		const canary_app_id = process.env.SPOODER_CANARY_APP_ID as string;
		const canary_app_key = process.env.SPOODER_CANARY_KEY as string;

		if (canary_app_id === undefined)
			throw new Error('SPOODER_CANARY_APP_ID environment variable is not set');

		if (canary_app_key === undefined)
			throw new Error('SPOODER_CANARY_KEY environment variable is not set');

		const key_file = Bun.file(canary_app_key);
		if (key_file.size === 0)
			throw new Error('Unable to read private key file defined by SPOODER_CANARY_KEY environment variable');

		const app_id = parseInt(canary_app_id, 10);
		if (isNaN(app_id))
			throw new Error('Invalid app ID defined by SPOODER_CANARY_APP_ID environment variable');

		let issue_title = report_title;
		let issue_body = '';

		report_body.push(generate_diagnostics());

		if (config.canary.sanitize) {
			const local_env = await load_local_env();
			issue_body = sanitize_string(JSON.stringify(report_body, null, 4), local_env);
			issue_title = sanitize_string(report_title, local_env);
		} else {
			issue_body = JSON.stringify(report_body, null, 4);
		}

		issue_body = '```json\n' + issue_body + '\n```\n\nℹ️ *This issue has been created automatically in response to a server panic, caution or crash.*';

		await create_github_issue({
			app_id,
			private_key: await key_file.text(),
			repository_name: canary_repostiory,
			login_name: canary_account,
			issue_title,
			issue_body,
			issue_labels: config.canary.labels
		});
	} catch (e) {
		log('[canary error] ' + (e as Error)?.message ?? 'unspecified error');
	}
}