import { format } from 'node:util';

/** Logs a message to stdout with the prefix `[spooder] ` */
export function log(message: string, ...args: unknown[]): void {
	let formatted_message = format('[{spooder}] ' + message, ...args);
	
	// Replace all {...} with text wrapped in ANSI color code 6.
	formatted_message = formatted_message.replace(/\{([^}]+)\}/g, '\x1b[38;5;6m$1\x1b[0m');

	process.stdout.write(formatted_message + '\n');
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