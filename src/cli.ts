#!/usr/bin/env node --experimental-vm-modules --no-warnings=ExpermentalWarning
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
import { log } from '@kogs/logger';
import { parse } from '@kogs/argv';
import { tryCatch, tryCatchAsync, printZodError } from './generics.js';
import git from './git.js';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';

const FILE_CLUSTER_CONFIG: string = 'spooder.config.json';
const FILE_ROUTER_SCRIPT: string = 'spooder.routes.mjs';

const SCHEMA_CLUSTER_CONFIG = z.object({
	domains: z.array(
		z.object({
			directory: z.string()
		}).strict()
	)
});

/**
 * Attempts to update the source code for a domain.
 *
 * @remarks
 * If the domain directory is a git repository, it will attempt to fetch changes from
 * the remote repository and pull them into the local repository. If successful, a list
 * of files that were changed will be returned.
 *
 * @param domainDir - The directory of the domain to update.
 * @returns An array of files that were changed, or false if the update failed.
 */
function updateDomainSource(domainDir: string): string[] | boolean {
	if (git.exists(domainDir)) {
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

		const filteredDiff = diff.filter(e => e.length > 0);

		// If there are changes, pull them from the remote repository.
		if (filteredDiff.length > 0) {
			log.info('Changes detected in {%d} files', filteredDiff.length);

			if (git.pull(domainDir) !== 0) {
				log.warn('{Sources not updated!} Unable to pull changes from git repository.');
				return false;
			}

			return filteredDiff;
		}
	}

	return false;
}

/**
 * Attempts to load the cluster configuration file.
 *
 * @remarks
 * Attempts to load the cluster configuration file FILE_CLUSTER_CONFIG from disk,
 * parse it as JSON and then validate it against SCHEMA_CLUSTER_CONFIG. If any
 * of these steps fail, a warning is logged and undefined is returned.
 *
 * @returns The parsed cluster configuration file, or undefined if it failed to load.
 */
function loadClusterConfig(): z.infer<typeof SCHEMA_CLUSTER_CONFIG> | undefined {
	const [rawError, raw] = tryCatch(() => fs.readFileSync(FILE_CLUSTER_CONFIG, 'utf-8'));
	if (rawError) {
		log.warn('{%s}: ' + rawError.message, FILE_CLUSTER_CONFIG);
		log.warn('Could not read config file {%s} from disk', FILE_CLUSTER_CONFIG);
		return;
	}

	const [jsonError, json] = tryCatch(() => JSON.parse(raw));
	if (jsonError) {
		log.warn('{%s}: ' + jsonError.message, FILE_CLUSTER_CONFIG);
		log.warn('Failed to parse JSON from config file {%s}', FILE_CLUSTER_CONFIG);
		return;
	}

	const [configError, config] = tryCatch(() => SCHEMA_CLUSTER_CONFIG.parse(json));
	if (configError) {
		printZodError(configError as z.ZodError);
		log.warn('Failed to parse config {%s}', FILE_CLUSTER_CONFIG);
		return;
	}

	return config;
}

/**
 * Attempts to initialize a domain.
 * @param domainDir - The directory of the domain to initialize.
 * @returns A promise that resolves when the domain has been initialized.
 */
async function loadDomain(domainDir: string): Promise<void> {
	const routeScript = path.join(domainDir, FILE_ROUTER_SCRIPT);

	const [routeScriptError, routeScriptText] = tryCatch(() => fs.readFileSync(routeScript, 'utf-8'));
	if (routeScriptError !== undefined) {
		log.error('{%s}: ' + routeScriptError.message, routeScript);
		return;
	}

	const context = createContext({ process });
	const stm = new SourceTextModule(routeScriptText, { context });

	await stm.link(async (identifier: string) => {
		if (identifier === 'spooder')
			identifier = './index.js';

		const module = await import(identifier);
		return new SyntheticModule([...Object.keys(module)], function() {
			for (const key of Object.keys(module))
				this.setExport(key, module[key]);
		}, { context });
	});

	const [stmError] = await tryCatchAsync(() => stm.evaluate());
	if (stmError !== undefined)
		log.error('{%s}: ' + stmError.message, routeScript);
}

(async (): Promise<void> => {
	const argv = parse(process.argv.slice(2));
	const argActionName = argv.arguments.asString(0);

	if (argActionName === 'cluster') {
		log.info('Starting server in {cluster} mode...');

		const config = loadClusterConfig();
		if (config !== undefined) {
			for (const domain of config.domains) {
				const domainDir = path.resolve(domain.directory);

				// Attempt to update the sources for the domain.
				const updatedFiles = updateDomainSource(domainDir);

				//const domainRouteScript = path.join(domainDir, FILE_ROUTER_SCRIPT);
			}
		}

		// TODO: Start each of the domains in the config file by parsing the source text of their
		// indivudual spooder.routes.mjs files and evaluating them.
	} else if (argActionName === 'dev') {
		log.info('Starting server in {development} mode...');

		await loadDomain('./');
	} else {
		log.error('Invalid operation, please consult the documentation.');
		return;
	}
})();