import { dispatch_report } from './dispatch';
import http from 'node:http';

async function handle_error(prefix: string, err_message_or_obj: string | object, ...err: unknown[]): Promise<void> {
	let error_message = 'unknown error';

	if (typeof err_message_or_obj === 'string') {
		error_message = err_message_or_obj;
		err.unshift(error_message);
	} else {
		if (err_message_or_obj instanceof Error)
			error_message = err_message_or_obj.message;

		err.push(err_message_or_obj);
	}

	// Serialize error objects.
	err = err.map(e => {
		if (e instanceof Error) {
			return {
				name: e.name,
				message: e.message,
				stack: e.stack?.split('\n') ?? []
			}
		}

		return e;
	})

	await dispatch_report(prefix + error_message, err);
}

export async function panic(err_message_or_obj: string | object, ...err: object[]): Promise<void> {
	await handle_error('panic: ', err_message_or_obj, ...err);
	process.exit(1);
}

export async function caution(err_message_or_obj: string | object, ...err: object[]): Promise<void> {
	await handle_error('caution: ', err_message_or_obj, ...err);
}

type HandlerReturnType = Response | number | Blob;
type RequestHandler = (req: Request) => HandlerReturnType;
type ErrorHandler = (err: Error) => HandlerReturnType;
type DefaultHandler = (req: Request, status_code: number) => HandlerReturnType;

export function serve(port: number) {
	const routes = new Map<string, RequestHandler>();
	const handlers = new Map<number, RequestHandler>();
	
	let error_handler: ErrorHandler | undefined;
	let default_handler: DefaultHandler | undefined;

	function resolve_handler(response: HandlerReturnType): Response | number {
		// Pre-assembled responses are returned as-is.
		if (response instanceof Response)
			return response;
	
		// Content-type/content-length are automatically set for blobs.
		if (response instanceof Blob)
			return new Response(response, { status: 200 });
	
		// Numbers are interpreted as status codes.
		const response_type = typeof response;
		if (response_type === 'number')
			return response;
	
		return 500; // TODO: Anything else should become plain text?
	}

	const server = Bun.serve({
		port,
		development: false,

		fetch(req: Request): Response {
			const url = new URL(req.url);
			const handler = routes.get(url.pathname);

			let status_code = 404;

			if (handler !== undefined) {
				const response = resolve_handler(handler(req));
				if (response instanceof Response)
					return response;

				status_code = response;
			}

			if (default_handler !== undefined) {
				const response = resolve_handler(default_handler(req, status_code));
				if (response instanceof Response)
					return response;

				status_code = response;
			}

			// Fallback to returning a basic response.
			return new Response(http.STATUS_CODES[status_code], { status: status_code });
		}
	});

	return {
		/** Register a handler for a specific route. */
		route: (path: string, handler: RequestHandler): void => {
			routes.set(path, handler);
		},

		/** Register a default handler for a specific response code. */
		default: (handler: DefaultHandler): void => {
			default_handler = handler;
		}
	}
}