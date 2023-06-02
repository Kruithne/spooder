#!/usr/bin/env bun
import { load_config } from './config';
import { parse_command_line } from './utils';

function log(message: string, ...args: unknown[]): void {
	console.log('[spooder] ' + message, ...args);
}

const config = await load_config();
const config_run_command = config.run as string ?? 'bun run index.ts';
const config_auto_restart_ms = config.autoRestart as number ?? 5000;

let config_update_commands = [] as string[];
if (config.update) {
	if (typeof config.update === 'string')
		config_update_commands = [config.update]
	else if (Array.isArray(config.update))
		config_update_commands = config.update;
}

async function start_server() {
	log('start_server');

	if (config_update_commands.length > 0) {
		log('running %d update commands', config_update_commands.length);

		for (let i = 0; i < config_update_commands.length; i++) {
			const config_update_command = config_update_commands[i];

			log('[%d] %s', i, config_update_command);

			const update_proc = Bun.spawn(parse_command_line(config_update_command), {
				cwd: process.cwd(),
				stdout: 'inherit',
				stderr: 'inherit'
			});

			await update_proc.exited;

			log('[%d] exited with code %d', i, update_proc.exitCode);

			if (update_proc.exitCode !== 0) {
				log('aborting update due to non-zero exit code from [%d]', i);
				break;
			}
		}
	}

	Bun.spawn(parse_command_line(config_run_command), {
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

await start_server();