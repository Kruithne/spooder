import { App } from '@octokit/app';
import { get_config } from './config';
import path from 'node:path';

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
// - Hook up dispatch_report() to panic()/caution() API functions.
// - Hook up dispatch_report() to the spooder runner on crash (add restart mention?).
// - Add a throttle to dispatch_report() to prevent spamming.
// - Implement system information (CPU, memory) to reports.
// - Update README documentation.

export async function dispatch_report(report_title: string, report_body: Record<string, unknown>): Promise<void> {
	const config = await get_config();
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

	const app = new App({
		appId: parseInt(canary_app_id, 10),
		privateKey: await key_file.text(),
	});

	await app.octokit.request('GET /app');

	const canary_account = config.canary.account.toLowerCase();
	const canary_repostiory = config.canary.repository.toLowerCase();
	const canary_labels = config.canary.labels;

	for await (const { installation } of app.eachInstallation.iterator()) {
		const login = (installation?.account as { login: string })?.login;
		if (login?.toLowerCase() !== canary_account)
			continue;

		for await (const { octokit, repository } of app.eachRepository.iterator({ installationId: installation.id })) {
			if (repository.full_name.toLowerCase() !== canary_repostiory)
				continue;

			const body = sanitize_string(JSON.stringify(report_body, null, 4), local_env);
			await octokit.request('POST /repos/' + canary_repostiory + '/issues', {
				title: sanitize_string(report_title, local_env),
				body: '```json\n' + body + '\n```\n\nℹ️ *This issue has been created automatically in response to a server panic or caution.*',
				labels: canary_labels
			});
		}
	}
}