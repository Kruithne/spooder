#!/usr/bin/env bun

import { join } from 'node:path';
import { z } from 'zod';

const ConfigSchema = z.object({
	domain: z.object({
		name: z.string(),
		port: z.number()
	}),

	git: z.object({
		url: z.string(),
		branch: z.string().default('main')
	}).optional()
});

async function get_last_pid() : Promise<number> {
	const pid_file = Bun.file(join(process.cwd(), '.spooder_pid'));
	if (pid_file.size > 0) {
		const pid = parseInt(await pid_file.text());
		if (!isNaN(pid))
			return pid;
	}

	return -1;
}

async function pid_is_running(pid: number) : Promise<boolean> {
	const process = Bun.spawnSync(['ps', '-p', pid.toString()]);
	if (!process.success)
		return false;

	const stdout = process.stdout?.toString();

	// Ensure stdout contains more than one line.
	if (!stdout || stdout.split('\n').length <= 1)
		return false;

	return false;
}

async function wait_for_pid_to_exit(pid: number) : Promise<void> {
	console.log(`Waiting for process ${pid} to exit...`);
	while (await pid_is_running(pid))
		await Bun.sleep(1000);
}

function is_git_repository(directory: string): boolean {
	// The command `git rev-parse --is-inside-work-tree` returns `true` to stdout
	// if the current working directory is inside a git repository.
	const process = Bun.spawnSync(['git', 'rev-parse', '--is-inside-work-tree'], { cwd: directory });
	return process.stdout?.toString().trim() === 'true';
}

function pull_git_repository(directory: string, url: string, branch: string) {
	console.log(`Pulling git repository ${branch} @ ${url} into ${directory}...`);
	const process = Bun.spawnSync(['git', 'pull', url, branch], { cwd: directory });
	if (!process.success)
		throw new Error('Failed to pull git repository.');
}

function init_git_repository(directory: string) {
	console.log(`Initializing git repository in ${directory}...`);
	const process = Bun.spawnSync(['git', 'init'], { cwd: directory });
	if (!process.success)
		throw new Error('Failed to initialize git repository.');
}

async function load_configuration() {
	const config_file = join(process.cwd(), 'spooder.toml');
	return ConfigSchema.parse((await import(config_file)).default);
}

async function main() {
	const config = await load_configuration();

	// Wait for the previous process, if it exists, to exit.
	await wait_for_pid_to_exit(await get_last_pid());

	const cwd = process.cwd();
	if (config.git) {
		if (!is_git_repository(cwd))
			init_git_repository(cwd);
		
		pull_git_repository(cwd, config.git.url, config.git.branch);
	}
	
	const server = Bun.spawn(['spooder'], { cwd });
	server.unref();
}

main();