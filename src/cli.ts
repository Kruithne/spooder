#!/usr/bin/env bun
import { get_config } from './config';
import { parse_command_line, log, strip_color_codes } from './utils';
import { dispatch_report } from './dispatch';

async function start_server() {
	log('start_server');

	const config = await get_config();

	const update_commands = config.update;
	const n_update_commands = update_commands.length;

	if (n_update_commands > 0) {
		log('running %d update commands', n_update_commands);

		for (let i = 0; i < n_update_commands; i++) {
			const config_update_command = update_commands[i];

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

	const proc = Bun.spawn(parse_command_line(config.run), {
		cwd: process.cwd(),
		stdout: 'inherit',
		stderr: 'pipe'
	});

	await proc.exited;

	const proc_exit_code = proc.exitCode;
	log('server exited with code %s', proc_exit_code);

	if (proc_exit_code !== 0) {
		if (proc.stderr !== undefined) {
			const res = new Response(proc.stderr as ReadableStream);

			res.text().then(async stderr => {
				await dispatch_report('crash: server exited unexpectedly', [{
					proc_exit_code,
					stderr: strip_color_codes(stderr).split(/\r?\n/)
				}]);
			});
		} else {
			dispatch_report('crash: service exited unexpectedly', [{
				proc_exit_code
			}]);
		}
	}

	const auto_restart_ms = config.autoRestart;
	if (auto_restart_ms > -1) {
		log('restarting server in %dms', auto_restart_ms);
		setTimeout(start_server, auto_restart_ms);
	}
}

await start_server();