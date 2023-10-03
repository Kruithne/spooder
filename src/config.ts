import path from 'node:path';
import { log } from './utils';

const internal_config = {
	run: 'bun run index.ts',
	auto_restart: -1,
	update: [],
	canary: {
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
				log('ignoring invalid configuration value `%s` (expected %s, got %s)', key_name, expected_type, actual_type);
				continue;
			}

			if (actual_type === 'object') {
				const is_default_array = Array.isArray(default_value);
				const is_actual_array = Array.isArray(value);

				if (is_default_array) {
					if (!is_actual_array) {
						log('ignoring invalid configuration value `%s` (expected array)', key_name);
						continue;
					}

					source[key as keyof Config] = value as Config[keyof Config];
				} else {
					if (is_actual_array) {
						log('ignoring invalid configuration value `%s` (expected object)', key_name);
						continue;
					}

					validate_config_option(default_value as ConfigObject, value as ConfigObject, key_name);
				}
			} else {
				source[key as keyof Config] = value as Config[keyof Config];
			}
		} else {
			log('ignoring unknown configuration key `%s`', key_name);	
		}
	}
}

async function load_config(): Promise<Config> {
	try {
		const config_file = Bun.file(path.join(process.cwd(), 'package.json'));
		const json = await config_file.json();

		if (json.spooder === null || typeof json.spooder !== 'object') {
			log('failed to parse spooder configuration in package.json, using defaults');
			return internal_config;
		}

		validate_config_option(internal_config, json.spooder, 'spooder');
	} catch (e) {
		log('failed to read package.json, using configuration defaults');
	}

	return internal_config;
}

export async function get_config(): Promise<Config> {
	if (cached_config === null)
		cached_config = await load_config();

	return cached_config;
}