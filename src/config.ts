import path from 'node:path';
import { log_create_logger } from './api';

const log_config = log_create_logger('config', 'spooder');

const internal_config = {
	run: 'bun run index.ts',
	run_dev: '',
	auto_restart: {
		enabled: false,
		backoff_max: 5 * 60 * 1000, // 5min
		backoff_grace: 30000, // 30s
		max_attempts: -1,
	},
	update: [],
	canary: {
		enabled: false,
		account: '',
		repository: '',
		labels: [],
		crash_console_history: 64,
		throttle: 86400,
		sanitize: true
	}
};

type Config = typeof internal_config;
type ConfigObject = Record<string, unknown>;

let cached_config: Config | null = null;

function validate_config_option(source: ConfigObject, target: ConfigObject, root_name: string) {
	for (const [key, value] of Object.entries(target)) {
		const key_name = `${root_name}.${key}`;
		if (key in source) {
			const default_value = source[key as keyof Config];
			const expected_type = typeof default_value;

			const actual_type = typeof value;

			if (actual_type !== expected_type) {
				log_config(`ignoring invalid configuration value {${key_name}} (expected {${expected_type}}, got {${actual_type}})`);
				continue;
			}

			if (actual_type === 'object') {
				const is_default_array = Array.isArray(default_value);
				const is_actual_array = Array.isArray(value);

				if (is_default_array) {
					if (!is_actual_array) {
						log_config(`ignoring invalid configuration value {${key_name}} (expected array)`);
						continue;
					}

					source[key as keyof Config] = value as Config[keyof Config];
				} else {
					if (is_actual_array) {
						log_config(`ignoring invalid configuration value '${key_name}' (expected object)`);
						continue;
					}

					validate_config_option(default_value as ConfigObject, value as ConfigObject, key_name);
				}
			} else {
				source[key as keyof Config] = value as Config[keyof Config];
			}
		} else {
			log_config(`ignoring unknown configuration key {${key_name}}`);
		}
	}
}

async function load_config(): Promise<Config> {
	try {
		const config_file = Bun.file(path.join(process.cwd(), 'package.json'));
		const json = await config_file.json();

		if (json.spooder === null || typeof json.spooder !== 'object') {
			log_config('failed to parse spooder configuration in {package.json}, using defaults');
			return internal_config;
		}

		validate_config_option(internal_config, json.spooder, 'spooder');
	} catch (e) {
		log_config('failed to read {package.json}, using configuration defaults');
	}

	return internal_config;
}

export async function get_config(): Promise<Config> {
	if (cached_config === null)
		cached_config = await load_config();

	return cached_config;
}