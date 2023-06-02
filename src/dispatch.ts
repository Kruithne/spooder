import { App } from '@octokit/app';
import { load_config } from './config';

type JSONObject = Record<string, unknown>;
type CanaryConfig = {
	account: string;
	repository: string;
	labels: string[] | undefined
};

let has_warned = false;

function invalid_canary_warning(info: string): null {
	if (has_warned)
		return null;

	console.warn('[warn] invalid canary configuration, reporting disabled');
	console.warn('[warn] %s', info);
	has_warned = true;
	return null;
}

function validate_canary_config(config: JSONObject): CanaryConfig | null {
	if (typeof config.canary !== 'object' || config.canary === null)
		return invalid_canary_warning('canary configuration is not an object');

	const canary_config = config.canary as CanaryConfig;
	if (typeof canary_config.account !== 'string')
		return invalid_canary_warning('canary.account is expected to be a string');

	if (typeof canary_config.repository !== 'string')
		return invalid_canary_warning('canary.repository is expected to be a string');

	return canary_config;
}

async function load_local_env(): Promise<Map<string, string>> {
	const env = new Map<string, string>();

	const env_file = Bun.file('.env.local');

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
// - Move the GitHub App ID and private key to a separate file/environment variable.
// - Add a throttle to dispatch_report() to prevent spamming.
// - Implement system information (CPU, memory) to reports.
// - Update README documentation.

export async function is_reporting_enabled(): Promise<boolean> {
	return false;
}

export async function dispatch_report(report_title: string, report_body: JSONObject): Promise<void> {
	const canary_config = validate_canary_config(await load_config());
	if (canary_config === null)
		return;

	const local_env = await load_local_env();

	const app = new App({
		appId: 341565,
		privateKey: await Bun.file('./spooder-bot.key').text(),
	});

	await app.octokit.request('GET /app');
	for await (const { installation } of app.eachInstallation.iterator()) {
		if (installation?.account?.login?.toLowerCase() !== canary_config.account)
			continue;

		for await (const { octokit, repository } of app.eachRepository.iterator({ installationId: installation.id })) {
			if (repository.full_name.toLowerCase() !== canary_config.repository)
				continue;

			const body = sanitize_string(JSON.stringify(report_body, null, 4), local_env);
			await octokit.request('POST /repos/' + canary_config.repository + '/issues', {
				title: sanitize_string(report_title, local_env),
				body: '```json\n' + body + '\n```\n\nℹ️ *This issue has been created automatically in response to a server panic or caution.*',
				labels: canary_config.labels ?? []
			});
		}
	}
}