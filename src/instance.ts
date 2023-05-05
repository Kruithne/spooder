#!/usr/bin/env bun

import { join } from 'node:path';

async function write_pid_file() {
	const pid_file = join(process.cwd(), '.spooder_pid');
	await Bun.write(pid_file, process.pid.toString());
}

async function main() {
	await write_pid_file();

	const index_file = join(process.cwd(), 'index.ts');
	// TODO: Add error handling if index_file does not exist?

	const module = await import(index_file);
	console.log(module);
	// TODO: Add a route for GitHub webhooks.
	// TODO: Add authentication for the webhook to prevent abuse.
	// TODO: Run `spooder-update` when the webhook is triggered, then self-terminate.
}

main();