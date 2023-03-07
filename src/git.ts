import { spawnSync } from 'child_process';

/**
 * Check if the given directory is a git repository.
 * @param dir - The directory to check.
 * @returns True if the given directory is a git repository, false otherwise.
 */
export function exists(dir: string): boolean {
	return spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir }).status === 0;
}

/**
 * Clone the git repository at the given URL into the given directory.
 * @param dir - The directory to clone the repository into.
 * @param url - The URL of the repository to clone.
 * @returns The status code of the git clone command.
 */
export function clone(dir: string, url: string): number {
	return spawnSync('git', ['clone', url, dir]).status;
}

/**
 * Get the remote URL of the git repository in the given directory.
 * @param dir - The directory to get the remote URL of.
 * @returns The status code of the command and the remote URL of the git repository in the given directory.
 */
export function getRemote(dir: string): [number, string] {
	const { status, stdout } = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: dir });
	return [status, stdout.toString()];
}

/**
 * Set the remote URL of the git repository in the given directory.
 * @param dir - The directory to set the remote URL of.
 * @param url - The URL to set the remote to.
 * @returns The status code of the git remote set-url command.
 */
export function setRemote(dir: string, url: string): number {
	return spawnSync('git', ['remote', 'set-url', 'origin', url], { cwd: dir }).status;
}

/**
 * Fetch the latest changes from the remote of the git repository in the given directory.
 * @param dir - The directory to fetch the git repository in.
 * @returns The status code of the git fetch command.
 */
export function fetch(dir: string): number {
	return spawnSync('git', ['fetch'], { cwd: dir }).status;
}

/**
 * Get the files that have changed between the local and remote git repository.
 * @param dir - The directory to get the git diff of.
 * @returns The files that have changed between the local and remote git repository.
 */
export function diff(dir: string): [number, string[]] {
	const { status, stdout } = spawnSync('git', ['diff', '--name-only', 'main...origin/main'], { cwd: dir });
	return [status, stdout.toString().split(/\r?\n/)];
}

/**
 * Pull the latest changes from the remote of the git repository in the given directory.
 * @param dir - The directory to pull the git repository in.
 * @returns The status code of the git pull command.
 */
export function pull(dir: string): number {
	return spawnSync('git', ['pull'], { cwd: dir }).status;
}

export default {
	exists,
	clone,
	getRemote,
	setRemote,
	fetch,
	diff,
	pull
};