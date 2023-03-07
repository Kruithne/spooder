import { z } from 'zod';
import { log } from '@kogs/logger';

/**
 * Try to run the given function and catch any errors that are thrown.
 * @param fn - The function to try and catch.
 * @param params - The parameters to pass to the function.
 * @returns An array containing the return value of the function and the error if one was thrown.
 */
export function tryCatch<T extends (...args: any[]) => any>(fn: T, ...params: any[]): [Error | undefined, ReturnType<T>] {
	try {
		return [undefined, fn(...params)];
	} catch (e) {
		return [e, undefined];
	}
}

/**
 * Try to run the given async function and catch any errors that are thrown.
 * @param fn - The function to try and catch.
 * @param params - The parameters to pass to the function.
 * @returns An array containing the return value of the function and the error if one was thrown.
 */
export async function tryCatchAsync<T extends (...args: any[]) => Promise<any>>(fn: T, ...params: any[]): Promise<[Error | undefined, ReturnType<T>]> {
	try {
		return [undefined, await fn(...params)];
	} catch (e) {
		return [e, undefined];
	}
}

/**
 * For each issue in the given ZodError, print a neatly formatted error message in the format:
 * Config error: {issue.message url} at {issue.path} (e.g Config error: {Invalid url} at {domains[0].source})
 * @param error - The error to print.
 */
export function printZodError(error: z.ZodError): void {
	for (const issue of error.issues) {
		const path = issue.path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${p}`)).join('');
		log.error('Config error: {%s} at {%s}', issue.message, path);
	}
}

export default {
	tryCatch,
	tryCatchAsync,
	printZodError
};