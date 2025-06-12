#!/usr/bin/env bun
import { get_config } from './config';
import { parse_command_line, log, strip_color_codes } from './utils';
import { dispatch_report } from './dispatch';

let restart_delay = 100;
let restart_attempts = 0;
let restart_success_timer: Timer | null = null;

async function start_server() {
	log('start_server');

	const argv = process.argv.slice(2);
	const is_dev_mode = argv.includes('--dev');
	const skip_updates = argv.includes('--no-update');

	if (is_dev_mode)
		log('[{dev}] spooder has been started in {dev mode}');

	const config = await get_config();

	if (is_dev_mode) {
		log('[{update}] skipping update commands in {dev mode}');
	} else if (skip_updates) {
		log('[{update}] skipping update commands due to {--no-update} flag');
	} else {
		const update_commands = config.update;
		const n_update_commands = update_commands.length;

		if (n_update_commands > 0) {
			log('running {%d} update commands', n_update_commands);

			for (let i = 0; i < n_update_commands; i++) {
				const config_update_command = update_commands[i];

				log('[{%d}] %s', i, config_update_command);

				const update_proc = Bun.spawn(parse_command_line(config_update_command), {
					cwd: process.cwd(),
					stdout: 'inherit',
					stderr: 'inherit'
				});

				await update_proc.exited;

				log('[{%d}] exited with code {%d}', i, update_proc.exitCode);

				if (update_proc.exitCode !== 0) {
					log('aborting update due to non-zero exit code from [%d]', i);
					break;
				}
			}
		}
	}

	const crash_console_history = config.canary.crash_console_history;
	const include_crash_history = crash_console_history > 0;

	const std_mode = include_crash_history ? 'pipe' : 'inherit';
	const proc = Bun.spawn(parse_command_line(config.run), {
		cwd: process.cwd(),
		env: { ...process.env, SPOODER_ENV: is_dev_mode ? 'dev' : 'prod' },
		stdout: std_mode,
		stderr: std_mode
	});

	const stream_history = new Array<string>();
	if (include_crash_history) {
		const text_decoder = new TextDecoder();

		function capture_stream(stream: ReadableStream, output: NodeJS.WritableStream) {
			const reader = stream.getReader();

			reader.read().then(function read_chunk(chunk) {
				if (chunk.done)
					return;

				const chunk_str = text_decoder.decode(chunk.value);
				for (const chunk of chunk_str.split(/\r?\n/))
					stream_history.push(chunk.trimEnd());

				if (stream_history.length > crash_console_history)
					stream_history.splice(0, stream_history.length - crash_console_history);

				output.write(chunk.value);
				reader.read().then(read_chunk);
			});
		}

		capture_stream(proc.stdout as ReadableStream, process.stdout);
		capture_stream(proc.stderr as ReadableStream, process.stderr);
	}
	
	const proc_exit_code = await proc.exited;
	log('server exited with code {%s}', proc_exit_code);
	
	if (proc_exit_code !== 0) {
		const console_output = include_crash_history ? strip_color_codes(stream_history.join('\n')) : undefined;

		if (is_dev_mode) {
			log('[{dev}] crash: server exited unexpectedly (exit code {%d})', proc_exit_code);
			log('[{dev}] without {--dev}, this would raise a canary report');
			log('[{dev}] console output:\n%s', console_output);
		} else {
			dispatch_report('crash: server exited unexpectedly', [{
				proc_exit_code, console_output
			}]);
		}
	}

	if (config.auto_restart) {
		if (is_dev_mode) {
			log('[{dev}] auto-restart is {disabled} in {dev mode}');
			process.exit(proc_exit_code ?? 0);
		} else if (proc_exit_code !== 0) {
			if (restart_success_timer) {
				clearTimeout(restart_success_timer);
				restart_success_timer = null;
			}
			
			if (config.auto_restart_attempts !== -1 && restart_attempts >= config.auto_restart_attempts) {
				log('maximum restart attempts ({%d}) reached, stopping auto-restart', config.auto_restart_attempts);
				process.exit(proc_exit_code ?? 0);
			}
			
			restart_attempts++;
			const current_delay = Math.min(restart_delay, config.auto_restart_max);
			
			log('restarting server in {%dms} (attempt {%d}/{%s}, delay capped at {%dms})', current_delay, restart_attempts, config.auto_restart_attempts === -1 ? '∞' : config.auto_restart_attempts, config.auto_restart_max);
			
			setTimeout(() => {
				restart_delay = Math.min(restart_delay * 2, config.auto_restart_max);
				restart_success_timer = setTimeout(() => {
					restart_delay = 100;
					restart_attempts = 0;
					restart_success_timer = null;
				}, config.auto_restart_grace);
				start_server();
			}, current_delay);
		}
	} else {
		log('auto-restart is {disabled}, exiting');
	}
}

await start_server();