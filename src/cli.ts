#!/usr/bin/env bun
import path from 'node:path';

type Config = Record<string, unknown>;

async function load_config(): Promise<Config> {
	try {
		const config_file = Bun.file(path.join(process.cwd(), 'package.json'));
		const json = await config_file.json();

		return json?.spooder ?? {};
	} catch (e) {
		return {};
	}
}

function parse_command(command: string): string[] {
	const args = [];
	let current_arg = '';
	let in_quotes = false;
	let in_escape = false;

	for (let i = 0; i < command.length; i++) {
		const char = command[i];

		if (in_escape) {
			current_arg += char;
			in_escape = false;
			continue;
		}

		if (char === '\\') {
			in_escape = true;
			continue;
		}

		if (char === '"') {
			in_quotes = !in_quotes;
			continue;
		}

		if (char === ' ' && !in_quotes) {
			args.push(current_arg);
			current_arg = '';
			continue;
		}

		current_arg += char;
	}

	if (current_arg.length > 0)
		args.push(current_arg);

	return args;
}

function log(message: string, ...args: unknown[]): void {
	console.log('[spooder] ' + message, ...args);
}

const config = await load_config();
const config_update_command = config.update as string ?? '';
const config_run_command = config.run as string ?? 'bun run index.ts';
const config_auto_restart_ms = config.autoRestart as number ?? 5000;

async function start_server() {
	log('start_server');

	if (config_update_command.length > 0) {
		log('running update command: %s', config_update_command);
		const update = Bun.spawn(parse_command(config_update_command), {
			cwd: process.cwd(),
			stdout: 'inherit',
			stderr: 'inherit'
		});

		await update.exited;
		log('auto update exited with code %d', update.exitCode)
	}

	Bun.spawn(parse_command(config_run_command), {
		cwd: process.cwd(),
		stdout: 'inherit',
		stderr: 'inherit',

		onExit: (proc, exitCode, signal) => {
			log('server exited with code %d', exitCode);

			if (config_auto_restart_ms > -1) {
				log('restarting server in %dms', config_auto_restart_ms);
				setTimeout(start_server, config_auto_restart_ms);
			}
		}
	});
}

start_server();