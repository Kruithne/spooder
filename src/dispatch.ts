import { App } from '@octokit/app';
import { get_config } from './config';
import { warn } from './utils';
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
		warn('Failed to read canary cache file ' + cache_file_path);
		warn('Error: ' + (e as Error).message);
		warn('You should resolve this issue to prevent spamming GitHub with canary reports.');
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
	input = input.replaceAll(/([0-9]{1,3}\.){3}[0-9]{1,3}/g, '[IPv4 Address]');

	// Strip IPv6 addresses.
	input = input.replaceAll(/([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}/g, '[IPv6 Address]');

	// Strip local environment variables.
	if (local_env !== undefined) {
		// Do not expose the name of the key redacted, as this may inadvertently expose the key/value
		// if the value coincidentally appears in some other context.
		for (const value of local_env.values())
			input = input.replaceAll(value, '[redacted]');
	}

	return input;
}

// TODO:
// - Hook up dispatch_report() to the spooder runner on crash (add restart mention?).
// - Add a throttle to dispatch_report() to prevent spamming.
// - Implement system information (CPU, memory) to reports.

export async function dispatch_report(report_title: string, report_body: object | undefined): Promise<void> {
	const config = await get_config();

	const canary_account = config.canary.account.toLowerCase();
	const canary_repostiory = config.canary.repository.toLowerCase();
	const canary_labels = config.canary.labels;

	// TODO: Validate canary_account and canary_repository.

	const is_cached = await check_cache_table(report_title, canary_repostiory, config.canary.throttle);
	if (is_cached) {
		warn('Throttled canary report: ' + report_title);
		return;
	}

	const local_env = await load_local_env();

	const canary_app_id = process.env.SPOODER_CANARY_APP_ID as string;
	const canary_app_key = process.env.SPOODER_CANARY_KEY as string;

	if (canary_app_id === undefined)
		throw new Error('dispatch_report() called without SPOODER_CANARY_APP_ID environment variable set');

	if (canary_app_key === undefined)
		throw new Error('dispatch_report() called without SPOODER_CANARY_KEY environment variable set');

	const key_file = Bun.file(canary_app_key);
	if (key_file.size === 0)
		throw new Error('dispatch_report() failed to read canary private key file');

	const app_id = parseInt(canary_app_id, 10);
	if (isNaN(app_id))
		throw new Error('dispatch_report() failed to parse SPOODER_CANARY_APP_ID environment variable as integer');

	const canary_sanitize = config.canary.sanitize;

	const app = new App({
		appId: app_id,
		privateKey: await key_file.text(),
	});

	await app.octokit.request('GET /app');

	let post_body = JSON.stringify(report_body, null, 4);
	if (canary_sanitize)
		post_body = sanitize_string(post_body, local_env);

	const post_object = {
		title: canary_sanitize ? sanitize_string(report_title, local_env) : report_title,
		body: '```json\n' + post_body + '\n```\n\nℹ️ *This issue has been created automatically in response to a server panic or caution.*',
		labels: canary_labels
	};

	for await (const { installation } of app.eachInstallation.iterator()) {
		const login = (installation?.account as { login: string })?.login;
		if (login?.toLowerCase() !== canary_account)
			continue;

		for await (const { octokit, repository } of app.eachRepository.iterator({ installationId: installation.id })) {
			if (repository.full_name.toLowerCase() !== canary_repostiory)
				continue;

			await octokit.request('POST /repos/' + canary_repostiory + '/issues', post_object);
		}
	}
}