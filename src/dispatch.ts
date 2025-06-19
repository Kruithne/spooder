import { get_config } from './config';
import { log_create_logger } from './api';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const log = log_create_logger('canary', 'spooder');

// region github
type GitHubInstallationResponse = Array<{
	id: number,
	account: {
		login: string
	},
	access_tokens_url: string,
	repositories_url: string
}>;

type GitHubAccessTokenResponse = {
	token: string;
};

type GitHubRepositoryResponse = {
	repositories: Array<{
		full_name: string,
		name: string,
		url: string,
		owner: {
			login: string
		}
	}>
};

type GitHubIssueResponse = {
	number: number,
	url: string
};

type GitHubIssue = {
	app_id: number,
	private_key: string,
	login_name: string,
	repository_name: string,
	issue_title: string,
	issue_body: string
	issue_labels?: Array<string>
};

function github_generate_jwt(app_id: number, private_key: string): string {
	const encoded_header = Buffer.from(JSON.stringify({
		alg: 'RS256',
		typ: 'JWT'
	})).toString('base64');

	const encoded_payload = Buffer.from(JSON.stringify({
		iat: Math.floor(Date.now() / 1000),
		exp: Math.floor(Date.now() / 1000) + 60,
		iss: app_id
	})).toString('base64');

	const sign = crypto.createSign('RSA-SHA256');
	sign.update(encoded_header + '.' + encoded_payload);

	return encoded_header + '.' + encoded_payload + '.' + sign.sign(private_key, 'base64');
}

async function github_request_endpoint(url: string, bearer: string, method: string = 'GET', body?: object): Promise<Response> {
	return fetch(url, {
		method,
		body: body ? JSON.stringify(body) : undefined,
		headers: {
			Authorization: 'Bearer ' + bearer,
			Accept: 'application/vnd.github.v3+json'
		}
	});
}

function github_assert_res(res: Response, message: string): void {
	if (!res.ok)
		throw new Error(message + ' (' + res.status + ' ' + res.statusText + ')');
}

async function github_create_issue(issue: GitHubIssue): Promise<void> {
	const jwt = github_generate_jwt(issue.app_id, issue.private_key);
	const app_res = await github_request_endpoint('https://api.github.com/app', jwt);

	github_assert_res(app_res, 'cannot authenticate GitHub app ' + issue.app_id);

	const res_installs = await github_request_endpoint('https://api.github.com/app/installations', jwt);
	github_assert_res(res_installs, 'cannot fetch GitHub app installations');

	const json_installs = await res_installs.json() as GitHubInstallationResponse;

	const login_name = issue.login_name.toLowerCase();
	const install = json_installs.find((install) => install.account.login.toLowerCase() === login_name);

	if (!install)
		throw new Error('spooder-bot is not installed on account ' + login_name);

	const res_access_token = await github_request_endpoint(install.access_tokens_url, jwt, 'POST');
	github_assert_res(res_access_token, 'cannot fetch GitHub app access token');

	const json_access_token = await res_access_token.json() as GitHubAccessTokenResponse;
	const access_token = json_access_token.token;

	const repositories = await github_request_endpoint(install.repositories_url, access_token);
	github_assert_res(repositories, 'cannot fetch GitHub app repositories');

	const repositories_json = await repositories.json() as GitHubRepositoryResponse;

	const repository_name = issue.repository_name.toLowerCase();
	const repository = repositories_json.repositories.find((repository) => repository.full_name.toLowerCase() === repository_name);

	if (!repository)
		throw new Error('spooder-bot is not installed on repository ' + repository_name);

	const issue_res = await github_request_endpoint(repository.url + '/issues', access_token, 'POST', {
		title: issue.issue_title,
		body: issue.issue_body,
		labels: issue.issue_labels
	});

	github_assert_res(issue_res, 'cannot create GitHub issue');

	const json_issue = await issue_res.json() as GitHubIssueResponse;
	log(`raised issue {${json_issue.number}} in {${repository.full_name}}: ${json_issue.url}`);
}
// endregion

// region canary
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
	await Bun.write(cache_file_path, data.buffer);
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
		log(`failed to read canary cache file {${cache_file_path}}`);
		log(`error: ${(e as Error).message}`);
		log('resolve this issue to prevent spamming GitHub with canary reports');
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
			log(`report dispatch failed; no canary account/repository configured`);
			return;
		}

		const is_cached = await check_cache_table(report_title, canary_repostiory, config.canary.throttle);
		if (is_cached) {
			log(`throttled canary report: {${report_title}}`);
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

		await github_create_issue({
			app_id,
			private_key: await key_file.text(),
			repository_name: canary_repostiory,
			login_name: canary_account,
			issue_title,
			issue_body,
			issue_labels: config.canary.labels
		});
	} catch (e) {
		log((e as Error).message);
	}
}
// endregion