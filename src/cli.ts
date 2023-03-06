#!/usr/bin/env node --experimental-vm-modules
import { domain, serve } from './index.js';
import { parse } from '@kogs/argv';
import { log, formatArray } from '@kogs/logger';
import git from './git.js';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';

const VALID_ACTIONS = ['run', 'deploy'];
const CONFIG_FILE = path.resolve('spooder.config.json');

const configSchema = z.object({
	domains: z.array(
		z.object({
			hostname: z.string(),
			source: z.string().url().optional(),
			directory: z.string().optional()
		}).strict()
	).min(1)
}).strict();

/**
 * Try to run the given function and catch any errors that are thrown.
 * @param fn - The function to try and catch.
 * @param params - The parameters to pass to the function.
 * @returns An array containing the return value of the function and the error if one was thrown.
 */
function tryCatch<T extends (...args: any[]) => any>(fn: T, ...params: any[]): [Error | undefined, ReturnType<T>] {
	try {
		return [undefined, fn(...params)];
	} catch (e) {
		return [e, undefined];
	}
}

/**
 * For each issue in the given ZodError, print a neatly formatted error message in the format:
 * Config error: {issue.message url} at {issue.path} (e.g Config error: {Invalid url} at {domains[0].source})
 * @param error - The error to print.
 */
function printZodError(error: z.ZodError): void {
	for (const issue of error.issues) {
		const path = issue.path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${p}`)).join('');
		log.error('Config error: {%s} at {%s}', issue.message, path);
	}
}

/**
 * Update the source repository of the given domain.
 * @param domainDir - The directory of the domain to update.
 * @param source - Remote URL of the source repository.
 * @returns An array of files that were changed, or false if the update failed.
 */
function updateSourceRepository(domainDir: string, source: string): string[] | boolean {
	if (git.exists(domainDir)) {
		const [remoteStatus, remote] = git.getRemote(domainDir);

		if (remoteStatus === 0) {
			if (remote !== source) {
				log.info('Repository remote does not match configuration, fixing...');
				if (git.setRemote(domainDir, source) !== 0) {
					log.warn('{Sources not updated!} Unable to change git remote in {%s}', domainDir);
					return false;
				}
			}
		} else {
			log.warn('{Sources not updated!} Unable to get remote origin for git repository.');
			return false;
		}

		if (git.fetch(domainDir) !== 0) {
			log.warn('{Sources not updated!} Unable to fetch changes from git repository.');
			return false;
		}

		const [diffStatus, diff] = git.diff(domainDir);
		if (diffStatus !== 0) {
			log.warn('{Sources not updated!} Unable to get diff between local and remote.');
			return false;
		}

		if (diff.length > 0) {
			log.info('Changes detected in {%d} files', diff.length);

			if (git.pull(domainDir) !== 0) {
				log.warn('{Sources not updated!} Unable to pull changes from git repository.');
				return false;
			}

			return diff;
		}
	} else {
		log.info('No git repository found, cloning...');
		if (git.clone(domainDir, source) !== 0) {
			log.warn('{Sources not updated!} Unable to clone git repository.');
			return false;
		}
	}
}

((): void => {
	const argv = parse();
	const argAction = argv.arguments[0];

	const [rawError, raw] = tryCatch(() => fs.readFileSync(CONFIG_FILE, 'utf-8'));
	if (rawError) {
		log.error('{%s}: ' + rawError.message, CONFIG_FILE);
		log.error('Could not read config file {%s} from disk', CONFIG_FILE);
		return;
	}

	const [jsonError, json] = tryCatch(() => JSON.parse(raw));
	if (jsonError) {
		log.error('{%s}: ' + jsonError.message, CONFIG_FILE);
		log.error('Failed to parse JSON from config file {%s}', CONFIG_FILE);
		return;
	}

	const [configError, config] = tryCatch(() => configSchema.parse(json));
	if (configError) {
		printZodError(configError as z.ZodError);
		log.error('Failed to parse config {%s}', CONFIG_FILE);
		return;
	}

	if (!VALID_ACTIONS.includes(argAction))
		return log.error('Unknown action {%s}, must be one of ' + formatArray(VALID_ACTIONS), argAction);

	if (argAction === 'run') {
		for (const domain of config.domains) {
			const domainDir = domain.directory ?? path.resolve('domains', domain.hostname);
			log.info('Preparing domain {%s} in {%s}', domain.hostname, domainDir);

			fs.mkdirSync(domainDir, { recursive: true });

			if (domain.source) {
				const changedFiles = updateSourceRepository(domainDir, domain.source);

				console.log(changedFiles);
			}
		}

		// TODO: Start the server with the configured domains.
		// TODO: Watch the config file and reconfigure the server when it changes?
	} else if (argAction === 'deploy') {
		// TODO: Implement.
	}
})();