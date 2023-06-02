import path from 'node:path';

type Config = Record<string, unknown>;

let cached_config: Config | undefined;

export async function load_config(): Promise<Config> {
	if (cached_config === undefined) {
		try {
			const config_file = Bun.file(path.join(process.cwd(), 'package.json'));
			const json = await config_file.json();

			cached_config = json?.spooder ?? {};
		} catch (e) {
			cached_config = {};
		}
	}

	return cached_config as Config;
}