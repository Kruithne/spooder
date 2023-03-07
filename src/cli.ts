#!/usr/bin/env node --experimental-vm-modules
import { domain, serve } from './index.js';
import { log } from '@kogs/logger';
import { tryCatch, printZodError } from './generics.js';
import git from './git.js';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';

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
 * Update the source repository of the given domain.
 * @param domainDir - The directory of the domain to update.
 * @param source - Remote URL of the source repository.
 * @returns An array of files that were changed, or false if the update failed.
 */
function updateSourceRepository(domainDir: string, source: string): string[] | boolean {
	if (git.exists(domainDir)) {
		const [remoteStatus, remote] = git.getRemote(domainDir);

		// Check if the remote origin configured on the repository matches what is configured
		// in the server config file. If it doesn't, set it using `git remote set-url`.
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

		// Fetch changes from the remote repository.
		if (git.fetch(domainDir) !== 0) {
			log.warn('{Sources not updated!} Unable to fetch changes from git repository.');
			return false;
		}

		// Get the diff between the local and remote respository.
		const [diffStatus, diff] = git.diff(domainDir);
		if (diffStatus !== 0) {
			log.warn('{Sources not updated!} Unable to get diff between local and remote.');
			return false;
		}

		// If there are changes, pull them from the remote repository.
		if (diff.length > 0) {
			log.info('Changes detected in {%d} files', diff.length);

			if (git.pull(domainDir) !== 0) {
				log.warn('{Sources not updated!} Unable to pull changes from git repository.');
				return false;
			}

			return diff;
		}
	} else {
		// Since we don't already have a git repository, we can just clone the remote repository.
		log.info('No git repository found, cloning...');

		if (git.clone(domainDir, source) !== 0) {
			log.warn('{Sources not updated!} Unable to clone git repository.');
			return false;
		}

		// We haven't got any "changed" files since we just cloned the repository.
		// Return an empty array to indicate that no files were changed.
		return [];
	}
}

((): void => {
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

	for (const domain of config.domains) {
		const domainDir = domain.directory ?? path.resolve('domains', domain.hostname);
		log.info('Preparing domain {%s} in {%s}', domain.hostname, domainDir);

		fs.mkdirSync(domainDir, { recursive: true });

		if (domain.source) {
			const changedFiles = updateSourceRepository(domainDir, domain.source);

			// TODO: Use the changed files to invalidate the CloudFlare cache.
			// TODO: Figure out how we'll handle query parameters with the CF invalidation.
		}
	}

	// TODO: Start the server with the configured domains.
	// TODO: Watch the config file and reconfigure the server when it changes?
})();