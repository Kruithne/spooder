#!/usr/bin/env bun
import { get_config } from './config';
import { dispatch_report } from './dispatch';
import { log_create_logger } from './api';

const log_cli = log_create_logger('spooder_cli');

let restart_delay = 100;
let restart_attempts = 0;
let restart_success_timer: Timer | null = null;

function strip_color_codes(str: string): string {
	return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function parse_command_line(command: string): string[] {
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

async function start_server() {
	log_cli('start_server');

	const argv = process.argv.slice(2);
	const is_dev_mode = argv.includes('--dev');
	const skip_updates = argv.includes('--no-update');

	if (is_dev_mode)
		log_cli('[{dev}] spooder has been started in {dev mode}');

	const config = await get_config();

	if (is_dev_mode) {
		log_cli('[{update}] skipping update commands in {dev mode}');
	} else if (skip_updates) {
		log_cli('[{update}] skipping update commands due to {--no-update} flag');
	} else {
		const update_commands = config.update;
		const n_update_commands = update_commands.length;

		if (n_update_commands > 0) {
			log_cli(`running {${n_update_commands}} updated commands`);

			for (let i = 0; i < n_update_commands; i++) {
				const config_update_command = update_commands[i];

				log_cli(`[{${i}}] ${config_update_command}`);

				const update_proc = Bun.spawn(parse_command_line(config_update_command), {
					cwd: process.cwd(),
					stdout: 'inherit',
					stderr: 'inherit'
				});

				await update_proc.exited;

				log_cli(`[{${i}}] exited with code {${update_proc.exitCode}}`);

				if (update_proc.exitCode !== 0) {
					log_cli(`aborting update due to non-zero exit code from [${i}]`);
					break;
				}
			}
		}
	}

	const crash_console_history = config.canary.crash_console_history;
	const include_crash_history = crash_console_history > 0;

	const std_mode = include_crash_history ? 'pipe' : 'inherit';
	const run_command = is_dev_mode && config.run_dev !== '' ? config.run_dev : config.run;
	const proc = Bun.spawn(parse_command_line(run_command), {
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
	log_cli(`server exited with code {${proc_exit_code}}`);
	
	if (proc_exit_code !== 0) {
		const console_output = include_crash_history ? strip_color_codes(stream_history.join('\n')) : undefined;

		if (is_dev_mode) {
			log_cli(`[{dev}] crash: server exited unexpectedly (exit code {${proc_exit_code}}`);
			log_cli(`[{dev}] without {--dev}, this would raise a canary report`);
			log_cli(`[{dev}] console output:\n${console_output}`);
		} else {
			dispatch_report('crash: server exited unexpectedly', [{
				proc_exit_code, console_output
			}]);
		}
	}

	if (config.auto_restart) {
		if (is_dev_mode) {
			log_cli(`[{dev}] auto-restart is {disabled} in {dev mode}`);
			process.exit(proc_exit_code ?? 0);
		} else if (proc_exit_code === 0) {
			start_server();
		} else {
			if (restart_success_timer) {
				clearTimeout(restart_success_timer);
				restart_success_timer = null;
			}
			
			if (config.auto_restart_attempts !== -1 && restart_attempts >= config.auto_restart_attempts) {
				log_cli(`maximum restart attempts ({${config.auto_restart_attempts}}) reached, stopping auto-restart`);
				process.exit(proc_exit_code ?? 0);
			}
			
			restart_attempts++;
			const current_delay = Math.min(restart_delay, config.auto_restart_max);
			
			const max_attempt_str = config.auto_restart_attempts === -1 ? '∞' : config.auto_restart_attempts;
			log_cli(`restarting server in {${current_delay}ms} (attempt {${restart_attempts}}/{${max_attempt_str}}, delay capped at {${config.auto_restart_max}ms})`);
			
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
		log_cli(`auto-restart is {disabled}, exiting`);
	}
}

await start_server();