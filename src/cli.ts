#!/usr/bin/env bun
import { get_config } from './config';
import { parse_command_line, log, strip_color_codes } from './utils';
import { dispatch_report } from './dispatch';

const MAX_CONSOLE_HISTORY = 64;

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
		stdout: 'pipe',
		stderr: 'pipe'
	});

	const stream_history = new Array<string>();
	const text_decoder = new TextDecoder();

	function capture_stream(stream: ReadableStream, output: NodeJS.WritableStream) {
		const reader = stream.getReader();

		reader.read().then(function read_chunk(chunk: ReadableStreamDefaultReadResult<Uint8Array>) {
			if (chunk.done)
				return;

			const chunk_str = text_decoder.decode(chunk.value);
			stream_history.push(...chunk_str.split(/\r?\n/));

			if (stream_history.length > MAX_CONSOLE_HISTORY)
				stream_history.splice(0, stream_history.length - MAX_CONSOLE_HISTORY);

			output.write(chunk.value);
			reader.read().then(read_chunk);
		});
	}

	capture_stream(proc.stdout as ReadableStream, process.stdout);
	capture_stream(proc.stderr as ReadableStream, process.stderr);
	
	await proc.exited;
	
	const proc_exit_code = proc.exitCode;
	log('server exited with code %s', proc_exit_code);
	
	if (proc_exit_code !== 0) {
		dispatch_report('crash: server exited unexpectedly', [{
			proc_exit_code,
			output: strip_color_codes(stream_history.join('\n'))
		}]);
	}
	  

	const auto_restart_ms = config.auto_restart;
	if (auto_restart_ms > -1) {
		log('restarting server in %dms', auto_restart_ms);
		setTimeout(start_server, auto_restart_ms);
	}
}

await start_server();