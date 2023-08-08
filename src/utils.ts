/** Logs a message to stdout with the prefix `[spooder] ` */
export function log(message: string, ...args: unknown[]): void {
	console.log('[spooder] ' + message, ...args);
}

/** Logs a message to stderr with the prefix `[spooder] ` */
export function warn(message: string, ...args: unknown[]): void {
	console.log('[spooder] ' + message, ...args);
}

/** Strips ANSI color codes from a string */
export function strip_color_codes(str: string): string {
	return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Converts a command line string into an array of arguments */
export function parse_command_line(command: string): string[] {
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