#!/usr/bin/env bun
import { get_config } from './config';
import { dispatch_report } from './dispatch';
import { log_create_logger, IPC_OP, IPC_TARGET, EXIT_CODE, EXIT_CODE_NAMES } from './api';

type Config = Awaited<ReturnType<typeof get_config>>;
type ProcessRef = ReturnType<typeof Bun.spawn>;

type InstanceConfig = {
	id: string;
	run: string;
	run_dev?: string;
	env?: Record<string, string>;
};

type Instance = {
	process: ProcessRef;
	ipc_listeners: Set<number>;
	restart_delay: number;
	restart_attempts: number;
	restart_success_timer: Timer | null;
};

const log_cli = log_create_logger('spooder_cli', 'spooder');
const log_cli_err = log_create_logger('spooder_cli', 'red');

const argv = process.argv.slice(2);
const is_dev_mode = argv.includes('--dev');

const instances = new Map<string, Instance>();
const instance_ipc_listeners = new Map<ProcessRef, Set<number>>();

let last_instance_start_time = 0;

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

async function apply_updates(config: Config) {
	if (is_dev_mode) {
		log_cli('[{update}] skipping update commands in {dev mode}');
	} else if (argv.includes('--no-update')) {
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
					log_cli_err(`aborting update due to non-zero exit code from [${i}]`);
					break;
				}
			}
		}
	}
}

async function handle_ipc(this: { instance_id: string, config: Config }, payload: any, proc: ProcessRef) {
	if (payload.peer === IPC_TARGET.SPOODER) {
		if (payload.op === IPC_OP.CMSG_TRIGGER_UPDATE) {
			await apply_updates(this.config);

			const payload = { op: IPC_OP.SMSG_UPDATE_READY };
			for (const instance of instances.values())
				instance.process.send(payload);
		} else if (payload.op === IPC_OP.CMSG_REGISTER_LISTENER) {
			instance_ipc_listeners.get(proc)?.add(payload.data.op);
		}
	} else if (payload.peer === IPC_TARGET.BROADCAST) {
		payload.peer = this.instance_id;
		for (const instance of instances.values()) {
			if (instance.process === proc)
				continue;

			if (instance.ipc_listeners.has(payload.op))
				instance.process.send(payload);
		}
	} else {
		const target = instances.get(payload.peer);
		if (target !== undefined && target.ipc_listeners.has(payload.op)) {
			payload.peer = this.instance_id;
			target.process.send(payload);
		}
	}
}

async function start_instance(instance: InstanceConfig, config: Config, update = false) {
	if (config.instance_stagger_interval > 0) {
		const current_time = Date.now();

		if (current_time > last_instance_start_time) {
			last_instance_start_time = current_time + config.instance_stagger_interval;
		} else {
			const delta = last_instance_start_time - current_time;
			last_instance_start_time += config.instance_stagger_interval;

			log_cli(`delaying {${instance.id}} for {${delta}ms} to satisfy {${config.instance_stagger_interval}ms} instance stagger`);
			await Bun.sleep(delta);
		}
	}

	log_cli(`starting server instance {${instance.id}}`);

	if (update)
		await apply_updates(config);

	const crash_console_history = config.canary.crash_console_history;
	const include_crash_history = crash_console_history > 0;

	const std_mode = include_crash_history ? 'pipe' : 'inherit';

	const run_command = is_dev_mode && instance.run_dev ? instance.run_dev : instance.run;
	const proc = Bun.spawn(parse_command_line(run_command), {
		cwd: process.cwd(),
		env: { ...process.env, ...instance.env, SPOODER_ENV: is_dev_mode ? 'dev' : 'prod', SPOODER_INSTANCE_ID: instance.id },
		stdout: std_mode,
		stderr: std_mode,
		ipc: handle_ipc.bind({ instance_id: instance.id, config })
	});

	const ipc_listeners = new Set<number>();

	const instance_state: Instance = {
		process: proc,
		ipc_listeners,
		restart_delay: 100,
		restart_attempts: 0,
		restart_success_timer: null
	};

	instances.set(instance.id, instance_state);
	instance_ipc_listeners.set(proc, ipc_listeners);

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
	const instance_data = instances.get(instance.id);

	if (instance_data?.restart_success_timer) {
		clearTimeout(instance_data.restart_success_timer);
		instance_data.restart_success_timer = null;
	}

	instances.delete(instance.id);
	instance_ipc_listeners.delete(proc);

	log_cli(`server {${instance.id}} exited with code {${proc_exit_code}} ({${EXIT_CODE_NAMES[proc_exit_code] ?? 'UNKNOWN'}})`);

	let is_safe_exit = proc_exit_code === EXIT_CODE.SUCCESS || proc_exit_code === EXIT_CODE.SPOODER_AUTO_UPDATE;
	if (!is_safe_exit) {
		const console_output = include_crash_history ? strip_color_codes(stream_history.join('\n')) : undefined;

		if (is_dev_mode) {
			log_cli_err(`[{dev}] crash: server {${instance.id}} exited unexpectedly (exit code {${proc_exit_code}}`);
			log_cli_err(`[{dev}] without {--dev}, this would raise a canary report`);
			log_cli_err(`[{dev}] console output:\n${console_output}`);
		} else {
			dispatch_report(`crash: server ${instance.id} exited unexpectedly`, [{
				proc_exit_code, console_output, instance
			}]);
		}
	}

	if (config.auto_restart.enabled) {
		const max_attempts = config.auto_restart.max_attempts;
		const backoff_max = config.auto_restart.backoff_max;

		if (is_dev_mode) {
			log_cli(`[{dev}] auto-restart is {disabled} in {dev mode}`);
			process.exit(proc_exit_code ?? 0);
		} else if (is_safe_exit) {
			const should_apply_updates = proc_exit_code !== EXIT_CODE.SPOODER_AUTO_UPDATE;
			setImmediate(() => start_instance(instance, config, should_apply_updates));
		} else {
			if (!instance_data) {
				log_cli_err(`cannot restart instance {${instance.id}}, instance data not found`);
				return;
			}

			if (instance_data.restart_success_timer) {
				clearTimeout(instance_data.restart_success_timer);
				instance_data.restart_success_timer = null;
			}

			if (max_attempts !== -1 && instance_data.restart_attempts >= max_attempts) {
				log_cli_err(`instance {${instance.id}} maximum restart attempts ({${max_attempts}}) reached, stopping auto-restart`);
				return;
			}

			instance_data.restart_attempts++;
			const current_delay = Math.min(instance_data.restart_delay, backoff_max);
			const max_attempt_str = max_attempts === -1 ? '∞' : max_attempts;

			log_cli(`restarting server {${instance.id}} in {${current_delay}ms} (attempt {${instance_data.restart_attempts}}/{${max_attempt_str}}, delay capped at {${backoff_max}ms})`);

			setTimeout(() => {
				instance_data.restart_delay = Math.min(instance_data.restart_delay * 2, backoff_max);
				instance_data.restart_success_timer = setTimeout(() => {
					instance_data.restart_delay = 100;
					instance_data.restart_attempts = 0;
					instance_data.restart_success_timer = null;
				}, config.auto_restart.backoff_grace);

				start_instance(instance, config, true);
			}, current_delay);
		}
	} else {
		log_cli(`auto-restart is {disabled}, exiting`);
	}
}

async function start_server() {
	if (is_dev_mode)
		log_cli('[{dev}] spooder has been started in {dev mode}');

	const config = await get_config();

	await apply_updates(config);

	const instances = config.instances;
	const n_instances = instances.length;

	if (instances.length > 0) {
		const instance_map = new Map<string, number>();

		for (let i = 0; i < n_instances; i++) {
			const instance = instances[i] as InstanceConfig;

			if (typeof instance.run !== 'string') {
				log_cli_err(`cannot start instance {${instance.id}}, missing {run} property`);
				continue;
			}

			if (typeof instance.id !== 'string')
				instance.id = 'instance_' + (i + 1);

			const used_idx = instance_map.get(instance.id);
			if (used_idx !== undefined) {
				log_cli_err(`cannot start instance {${instance.id}} (index {${i}}), instance ID already in use (index {${used_idx}})`);
				continue;
			}

			if (instance.id.startsWith('__') && instance.id.endsWith('__')) {
				log_cli_err(`cannot start instance {${instance.id}} using internal naming syntax`);
				log_cli_err(`instance names with {__} prefix and suffix are reserved`);
				continue;
			}

			instance_map.set(instance.id, i);
			start_instance(instance, config);
		}
	} else {
		if (config.run.length === 0)
			return log_cli_err(`cannot start main instance, missing {run} property`);

		start_instance({
			id: 'main',
			run: config.run,
			run_dev: config.run_dev !== '' ? config.run_dev : undefined
		}, config);
	}
}

await start_server();