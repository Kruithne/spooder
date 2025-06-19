<p align="center"><img src="docs/project-logo.png"/></p>

# spooder &middot; ![typescript](https://img.shields.io/badge/language-typescript-blue) [![license badge](https://img.shields.io/github/license/Kruithne/spooder?color=yellow)](LICENSE) ![npm version](https://img.shields.io/npm/v/spooder?color=c53635) ![bun](https://img.shields.io/badge/runtime-bun-f9f1e1)

`spooder` is a purpose-built server solution that shifts away from the dependency hell of the Node.js ecosystem, with a focus on stability and performance, which is why:
- It is built using the [Bun](https://bun.sh/) runtime and not designed to be compatible with Node.js or other runtimes.
- It uses zero dependencies and only relies on code written explicitly for `spooder` or APIs provided by the Bun runtime, often implemented in native code.
- It provides streamlined APIs for common server tasks in a minimalistic way, without the overhead of a full-featured web framework.
- It is opinionated in its design to reduce complexity and overhead.

The design goal behind `spooder` is not to provide a full-featured web server, but to expand the Bun runtime with a set of APIs and utilities that make it easy to develop servers with minimal overhead.

> [!NOTE]
> If you think a is missing a feature, consider opening an issue with your use-case. The goal behind `spooder` is to provide APIs that are useful for a wide range of use-cases, not to provide bespoke features better suited for userland.

It consists of two components, the `CLI` and the `API`. 
- The `CLI` is responsible for keeping the server process running, applying updates in response to source control changes, and automatically raising issues on GitHub via the canary feature.
- The `API` provides a minimal building-block style API for developing servers, with a focus on simplicity and performance.

# Installation

```bash
# Installing globally for CLI runner usage.
bun add spooder --global

# Install into local package for API usage.
bun add spooder
```

# Configuration

Both the `CLI` and the API are configured in the same way by providing a `spooder` object in your `package.json` file.

Below is a full map of the available configuration options in their default states. All configuration options are **optional**.

```jsonc
{
	"spooder": {

		// see CLI > Auto Restart
		"auto_restart": true,
		"auto_restart_max": 30000,
		"auto_restart_attempts": 10,
		"auto_restart_grace": 30000,

		// see CLI > Auto Update
		"update": [
			"git pull",
			"bun install"
		],

		// see CLI > Canary
		"canary": {
			"account": "",
			"repository": "",
			"labels": [],
			"crash_console_history": 64,
			"throttle": 86400,
			"sanitize": true
		}
	}
}
```

If there are any issues with the provided configuration, a warning will be printed to the console but will not halt execution. `spooder` will always fall back to default values where invalid configuration is provided.

> [!NOTE]
> Configuration warnings **do not** raise `caution` events with the `spooder` canary functionality.

# CLI

The `CLI` component of `spooder` is a global command-line tool for running server processes.

- [CLI > Usage](#cli-usage)
- [CLI > Dev Mode](#cli-dev-mode)
- [CLI > Auto Restart](#cli-auto-restart)
- [CLI > Auto Update](#cli-auto-update)
- [CLI > Canary](#cli-canary)
	- [CLI > Canary > Crash](#cli-canary-crash)
	- [CLI > Canary > Sanitization](#cli-canary-sanitization)
	- [CLI > Canary > System Information](#cli-canary-system-information)

# API

`spooder` exposes a simple yet powerful API for developing servers. The API is designed to be minimal to leave control in the hands of the developer and not add overhead for features you may not need.

- [API > Cheatsheet](#api-cheatsheet)
- [API > Logging](#api-logging)
- [API > HTTP](#api-http)
	- [API > HTTP > Directory Serving](#api-http-directory)
	- [API > HTTP > Server-Sent Events (SSE)](#api-http-sse)
	- [API > HTTP > Webhooks](#api-http-webhooks)
	- [API > HTTP > Websocket Server](#api-http-websockets)
- [API > Error Handling](#api-error-handling)
- [API > Workers](#api-workers)
- [API > Caching](#api-caching)
- [API > Templating](#api-templating)
- [API > Database](#api-database)
	- [API > Database > Schema](#api-database-schema)
	- [API > Database > Interface](#api-database-interface)
		- [API > Database > Interface > SQLite](#api-database-interface-sqlite)
		- [API > Database > Interface > MySQL](#api-database-interface-mysql)
- [API > Utilities](#api-utilities)

# CLI

<a id="cli-usage"></a>
## CLI > Usage

For convenience, it is recommended that you run this in a `screen` session.

```bash
screen -S my-website-about-fish.net
cd /var/www/my-website-about-fish.net/
spooder
```

`spooder` will launch your server either by executing the `run` command provided in the configuration, or by executing `bun run index.ts` by default.

```json
{
	"spooder": {
		"run": "bun run my_server.ts"
	}
}
```

While `spooder` uses a `bun run` command by default, it is possible to use any command string. For example if you wanted to launch a server using `node` instead of `bun`, you could do the following.

```json
{
	"spooder": {
		"run": "node my_server.js"
	}
}
```

<a id="cli-dev-mode"></a>
## CLI > Dev Mode

`spooder` can be started in development mode by providing the `--dev` flag when starting the server.

```bash
spooder --dev
```

The following differences will be observed when running in development mode:

- Update commands defined in `spooder.update` will not be executed when starting a server.
- If the server crashes and `auto_restart` is enabled, the server will not be restarted, and spooder will exit with the same exit code as the server.
- If canary is configured, reports will not be dispatched to GitHub and instead be printed to the console; this includes crash reports.

It is possible to detect in userland if a server is running in development mode by checking the `SPOODER_ENV` environment variable.

```ts
if (process.env.SPOODER_ENV === 'dev') {
	// Server is running in development mode.
}
```

> [!NOTE]
> `SPOODER_ENV` should be either `dev` or `prod`. If the variable is not defined, the server was not started by the `spooder` CLI.

<a id="cli-auto-restart"></a>
## CLI > Auto Restart

> [!NOTE]
> This feature is not enabled by default.

In the event that the server process exits with a non-zero exit code, `spooder` can automatically restart it using an exponential backoff strategy. To enable this feature set `auto_restart` to `true` in the configuration.

```json
{
	"spooder": {
		"auto_restart": true,
		"auto_restart_max": 30000,
		"auto_restart_attempts": 10,
		"auto_restart_grace": 30000
	}
}
```

### Configuration Options

- **`auto_restart`** (boolean, default: `false`): Enable or disable the auto-restart feature
- **`auto_restart_max`** (number, default: `30000`): Maximum delay in milliseconds between restart attempts
- **`auto_restart_attempts`** (number, default: `-1`): Maximum number of restart attempts before giving up. Set to `-1` for unlimited attempts
- **`auto_restart_grace`** (number, default: `30000`): Period of time after which the backoff protocol disables if the server remains stable.

If the server exits with a zero exit code (successful termination), auto-restart will not trigger.

<a id="cli-auto-update"></a>
## CLI > Auto Update

> [!NOTE]
> This feature is not enabled by default.

When starting or restarting a server process, `spooder` can automatically update the source code in the working directory. To enable this feature, the necessary update commands can be provided in the configuration as an array of strings.

```json
{
	"spooder": {
		"update": [
			"git reset --hard",
			"git clean -fd",
			"git pull origin main",
			"bun install"
		]
	}
}
```

Each command should be a separate entry in the array and will be executed in sequence. The server process will be started once all commands have resolved.

> [!IMPORTANT]
> Chaining commands using `&&` or `||` operators does not work.

If a command in the sequence fails, the remaining commands will not be executed, however the server will still be started. This is preferred over entering a restart loop or failing to start the server at all.

You can utilize this to automatically update your server in response to a webhook by exiting the process.

```ts
server.webhook(process.env.WEBHOOK_SECRET, '/webhook', payload => {
	setImmediate(async () => {
		await server.stop(false);
		process.exit();
	});
	return 200;
});
```

### Skip Updates

In addition to being skipped in [dev mode](#cli-dev-mode), updates can also be skipped in production mode by passing the `--no-update` flag.

<a id="cli-canary"></a>
## CLI > Canary

> [!NOTE]
> This feature is not enabled by default.

`canary` is a feature in `spooder` which allows server problems to be raised as issues in your repository on GitHub.

To enable this feature, you will need a GitHub app which has access to your repository and a corresponding private key. If you do not already have those, instructions can be found below.

<details>
<summary>GitHub App Setup</summary>

Create a new GitHub App either on your personal account or on an organization. The app will need the following permissions:

- **Issues** - Read & Write
- **Metadata** - Read-only

Once created, install the GitHub App to your account. The app will need to be given access to the repositories you want to use the canary feature with.

In addition to the **App ID** that is assigned automatically, you will also need to generate a **Private Key** for the app. This can be done by clicking the **Generate a private key** button on the app page.

> [!NOTE]
> The private keys provided by GitHub are in PKCS#1 format, but only PKCS#8 is supported. You can convert the key file with the following command.

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in private-key.pem -out private-key-pkcs8.key
```

Each server that intends to use the canary feature will need to have the private key installed somewhere the server process can access it.
</details>

### Configure Canary

```json
"spooder": {
	"canary": {
		"account": "<GITHUB_ACCOUNT_NAME>",
		"repository": "<GITHUB_REPOSITORY>",
		"labels": ["some-label"]
	}
}
```

Replace `<GITHUB_ACCOUNT_NAME>` with the account name you have installed the GitHub App to, and `<GITHUB_REPOSITORY>` with the repository name you want to use for issues.

The repository name must in the full-name format `owner/repo` (e.g. `facebook/react`).

The `labels` property can be used to provide a list of labels to automatically add to the issue. This property is optional and can be omitted.

### Setup Environment Variables

The following two environment variables must be defined on the server.

```
SPOODER_CANARY_APP_ID=1234
SPOODER_CANARY_KEY=/home/bond/.ssh/id_007_pcks8.key
```

`SPOODER_CANARY_APP_ID` is the **App ID** as shown on the GitHub App page.

`SPOODER_CANARY_KEY` is the path to the private key file in PKCS#8 format.

> [!NOTE]
> Since `spooder` uses the Bun runtime, you can use the `.env.local` file in the project root directory to set these environment variables per-project.

### Using Canary

Once configured, `spooder` will automatically raise an issue when the server exits with a non-zero exit code. 

In addition, you can manually raise issues using the `spooder` API by calling `caution()` or `panic()`. More information about these functions can be found in the `API` section.

If `canary` has not been configured correctly, `spooder` will only print warnings to the console when it attempts to raise an issue.

> [!WARNING]
> Consider testing the canary feature with the `caution()` function before relying on it for critical issues.

<a id="cli-canary-crash"></a>
## CLI > Canary > Crash

It is recommended that you harden your server code against unexpected exceptions and use `panic()` and `caution()` to raise issues with selected diagnostic information.

In the event that the server does encounter an unexpected exception which causes it to exit with a non-zero exit code, `spooder` will provide some diagnostic information in the canary report.

Since this issue has been caught externally, `spooder` has no context of the exception which was raised. Instead, the canary report will contain the output from both `stdout` and `stderr`.

```json
{
	"proc_exit_code": 1,
	"console_output": [
		"[2.48ms] \".env.local\"",
		"Test output",
		"Test output",
		"4 | console.warn('Test output');",
		"5 | ",
		"6 | // Create custom error class.",
		"7 | class TestError extends Error {",
		"8 | 	constructor(message: string) {",
		"9 | 		super(message);",
		"     ^",
		"TestError: Home is [IPv4 address]",
		"      at new TestError (/mnt/i/spooder/test.ts:9:2)",
		"      at /mnt/i/spooder/test.ts:13:6",
		""
	]
}
```

The `proc_exit_code` property contains the exit code that the server exited with.

The `console_output` will contain the last `64` lines of output from `stdout` and `stderr` combined. This can be configured by setting the `spooder.canary.crash_console_history` property to a length of your choice.

```json
{
	"spooder": {
		"canary": {
			"crash_console_history": 128
		}
	}
}
```

This information is subject to sanitization, as described in the `CLI > Canary > Sanitization` section, however you should be aware that stack traces may contain sensitive information.

Setting `spooder.canary.crash_console_history` to `0` will omit the `console_output` property from the report entirely, which may make it harder to diagnose the problem but will ensure that no sensitive information is leaked.

<a id="cli-canary-sanitization"></a>
## CLI > Canary > Sanitization

All reports sent via the canary feature are sanitized to prevent sensitive information from being leaked. This includes:

- Environment variables from `.env.local`
- IPv4 / IPv6 addresses.
- E-mail addresses.

```bash
# .env.local
DB_PASSWORD=secret
```

```ts
await panic({
	a: 'foo',
	b: process.env.DB_PASSWORD,
	c: 'Hello person@place.net',
	d: 'Client: 192.168.1.1'
});
```

```json
[
	{
		"a": "foo",
		"b": "[redacted]",
		"c": "Hello [e-mail address]",
		"d": "Client: [IPv4 address]"
	}
]
```

The sanitization behavior can be disabled by setting `spooder.canary.sanitize` to `false` in the configuration. This is not recommended as it may leak sensitive information.

```json
{
	"spooder": {
		"canary": {
			"sanitize": false
		}
	}
}
```

> [!WARNING]
> While this sanitization adds a layer of protection against information leaking, it does not catch everything. You should pay special attention to messages and objects provided to the canary to not unintentionally leak sensitive information.

<a id="cli-canary-system-information"></a>
## CLI > Canary > System Information

In addition to the information provided by the developer, `spooder` also includes some system information in the canary reports.

```json
{
	"loadavg": [
		0,
		0,
		0
	],
	"memory": {
		"free": 7620907008,
		"total": 8261840896
	},
	"platform": "linux",
	"uptime": 7123,
	"versions": {
		"node": "18.15.0",
		"bun": "0.6.5",
		"webkit": "60d11703a533fd694cd1d6ddda04813eecb5d69f",
		"boringssl": "b275c5ce1c88bc06f5a967026d3c0ce1df2be815",
		"libarchive": "dc321febde83dd0f31158e1be61a7aedda65e7a2",
		"mimalloc": "3c7079967a269027e438a2aac83197076d9fe09d",
		"picohttpparser": "066d2b1e9ab820703db0837a7255d92d30f0c9f5",
		"uwebsockets": "70b1b9fc1341e8b791b42c5447f90505c2abe156",
		"zig": "0.11.0-dev.2571+31738de28",
		"zlib": "885674026394870b7e7a05b7bf1ec5eb7bd8a9c0",
		"tinycc": "2d3ad9e0d32194ad7fd867b66ebe218dcc8cb5cd",
		"lolhtml": "2eed349dcdfa4ff5c19fe7c6e501cfd687601033",
		"ares": "0e7a5dee0fbb04080750cf6eabbe89d8bae87faa",
		"usockets": "fafc241e8664243fc0c51d69684d5d02b9805134",
		"v8": "10.8.168.20-node.8",
		"uv": "1.44.2",
		"napi": "8",
		"modules": "108"
	},
	"bun": {
		"version": "0.6.5",
		"rev": "f02561530fda1ee9396f51c8bc99b38716e38296",
		"memory_usage": {
			"rss": 99672064,
			"heapTotal": 3039232,
			"heapUsed": 2332783,
			"external": 0,
			"arrayBuffers": 0
		},
		"cpu_usage": {
			"user": 50469,
			"system": 0
		}
	}
}
```

# API

<a id="api-cheatsheet"></a>
## API > Cheatsheet

```ts
// logging
log(message: string);
log_create_logger(prefix: string, color: ColorInput);
log_list(input: any[], delimiter = ', ');

// http
http_serve(port: number, hostname?: string): Server;
server.stop(immediate: boolean): Promise<void>;

// routing
server.route(path: string, handler: RequestHandler, method?: HTTP_METHODS);
server.json(path: string, handler: JSONRequestHandler, method?: HTTP_METHODS);
server.unroute(path: string);

// fallback handlers
server.handle(status_code: number, handler: RequestHandler);
server.default(handler: DefaultHandler);
server.error(handler: ErrorHandler);
server.on_slow_request(callback: SlowRequestCallback, threshold?: number);
server.allow_slow_request(req: Request);

// http generics
http_apply_range(file: BunFile, request: Request): HandlerReturnType;

// directory serving
server.dir(path: string, dir: string, options?: DirOptions | DirHandler, method?: HTTP_METHODS);

// server-sent events
server.sse(path: string, handler: ServerSentEventHandler);

// webhooks
server.webhook(secret: string, path: string, handler: WebhookHandler);

// websockets
server.websocket(path: string, handlers: WebsocketHandlers);

// error handling
ErrorWithMetadata(message: string, metadata: object);
caution(err_message_or_obj: string | object, ...err: object[]): Promise<void>;
panic(err_message_or_obj: string | object, ...err: object[]): Promise<void>;
safe(fn: Callable): Promise<void>;
set_error_mode(mode: ERR_MODE): void;
get_error_mode(): ERR_MODE;

// worker
worker_event_pipe(worker: Worker | typeof self): WorkerEventPipe;
pipe.send(id: string, data?: object): void;
pipe.on(event: string, callback: (data: object) => void | Promise<void>): void;
pipe.once(event: string, callback: (data: object) => void | Promise<void>): void;
pipe.off(event: string): void;

// templates
parse_template(template: string, replacements: Record<string, string>, drop_missing?: boolean): Promise<string>;
generate_hash_subs(length?: number, prefix?: string, hashes?: Record<string, string>): Promise<Record<string, string>>;
get_git_hashes(length: number): Promise<Record<string, string>>;

// database interface
db_sqlite(filename: string, options: number|object): db_sqlite;
db_mysql(options: ConnectionOptions, pool: boolean): Promise<MySQLDatabaseInterface>;
db_cast_set<T extends string>(set: string | null): Set<T>;
db_serialize_set<T extends string>(set: Set<T> | null): string;

// db_sqlite
update_schema(db_dir: string, schema_table?: string): Promise<void>
insert(sql: string, ...values: any): number;
insert_object(table: string, obj: Record<string, any>): number;
execute(sql: string, ...values: any): number;
get_all<T>(sql: string, ...values: any): T[];
get_single<T>(sql: string, ...values: any): T | null;
get_column<T>(sql: string, column: string, ...values: any): T[];
get_paged<T>(sql: string, values?: any[], page_size?: number): AsyncGenerator<T[]>;
count(sql: string, ...values: any): number;
count_table(table_name: string): number;
exists(sql: string, ...values: any): boolean;
transaction(scope: (transaction: SQLiteDatabaseInterface) => void | Promise<void>): boolean;

// db_mysql
update_schema(db_dir: string, schema_table?: string): Promise<void>
insert(sql: string, ...values: any): Promise<number>;
insert_object(table: string, obj: Record<string, any>): Promise<number>;
execute(sql: string, ...values: any): Promise<number>;
get_all<T>(sql: string, ...values: any): Promise<T[]>;
get_single<T>(sql: string, ...values: any): Promise<T | null>;
get_column<T>(sql: string, column: string, ...values: any): Promise<T[]>;
call<T>(func_name: string, ...args: any): Promise<T[]>;
get_paged<T>(sql: string, values?: any[], page_size?: number): AsyncGenerator<T[]>;
count(sql: string, ...values: any): Promise<number>;
count_table(table_name: string): Promise<number>;
exists(sql: string, ...values: any): Promise<boolean>;
transaction(scope: (transaction: MySQLDatabaseInterface) => void | Promise<void>): Promise<boolean>;

// database schema
db_update_schema_sqlite(db: Database, schema_dir: string, schema_table?: string): Promise<void>;
db_update_schema_mysql(db: Connection, schema_dir: string, schema_table?: string): Promise<void>;

// caching
cache_http(options?: CacheOptions);

// utilities
filesize(bytes: number): string;

// constants
HTTP_STATUS_CODE: Record<number, string>;
ERR_MODE: Record<string, number>;
```

<a id="api-logging"></a>
## API > Logging

### 🔧 `log(message: string)`
Print a message to the console using the default logger. Wrapping text segments in curly braces will highlight those segments with colour.

```ts
log('Hello, {world}!');
// > [info] Hello, world!
```

### 🔧 `log_create_logger(prefix: string, color: ColorInput)`
Create a `log()` function with a custom prefix and highlight colour.

```ts
const db_log = log_create_logger('db', 'pink');
db_log('Creating table {users}...');
```

> [!INFO]
> For information about `ColorInput`, see the [Bun Color API](https://bun.sh/docs/api/color).


### 🔧 `log_list(input: any[], delimiter = ', ')`
Utility function that joins an array of items together with each element wrapped in highlighting syntax for logging.

```ts
const fruit = ['apple', 'orange', 'peach'];
log(`Fruit must be one of ${fruit.map(e => `{${e}}`).join(', ')}`);
log(`Fruit must be one of ${log_list(fruit)}`);
```

<a id="api-http"></a>
## API > HTTP

### `http_serve(port: number, hostname?: string): Server`
Bootstrap a server on the specified port (and optional hostname).

```ts
import { serve } from 'spooder';

const server = http_serve(8080); // port only
const server = http_serve(3000, '0.0.0.0'); // optional hostname
```

By default, the server responds with:

```http
HTTP/1.1 404 Not Found
Content-Length: 9
Content-Type: text/plain;charset=utf-8

Not Found
```

### 🔧 `server.stop(immediate: boolean)`

Stop the server process immediately, terminating all in-flight requests.

```ts
server.stop(true);
```

Stop the server process gracefully, waiting for all in-flight requests to complete.

```ts
server.stop(false);
```

`server.stop()` returns a promise, which if awaited, resolves when all pending connections have been completed.
```ts
await server.stop(false);
// do something now all connections are done
```

### Routing

### 🔧 `server.route(path: string, handler: RequestHandler)`

Register a handler for a specific path.

```ts
server.route('/test/route', (req, url) => {
	return new Response('Hello, world!', { status: 200 });
});
```

### 🔧 `server.unroute(path: string)`

Unregister a specific route.

```ts
server.route('/test/route', () => {});
server.unroute('/test/route');
```

### 🔧 `server.json(path: string, handler: JSONRequestHandler, method?: HTTP_METHODS)`

Register a JSON endpoint with automatic content validation. This method automatically validates that the request has the correct `Content-Type: application/json` header and that the request body contains a valid JSON object.

```ts
server.json('/api/users', (req, url, json) => {
	// json is automatically parsed and validated as a plain object
	const name = json.name;
	const email = json.email;
	
	// Process the JSON data
	return { success: true, id: 123 };
});
```

By default, JSON routes are registered as `POST` endpoints, but this can be customized:

```ts
server.json('/api/data', (req, url, json) => {
	return { received: json };
}, 'PUT');
```

The handler will automatically return `400 Bad Request` if:
- The `Content-Type` header is not `application/json`
- The request body is not valid JSON
- The JSON is not a plain object (e.g., it's an array, null, or primitive value)

### HTTP Methods

By default, `spooder` will register routes defined with `server.route()` and `server.dir()` as `GET` routes, while `server.json()` routes default to `POST`. Requests to these routes with other methods will return `405 Method Not Allowed`.

> [!NOTE]
> spooder does not automatically handle HEAD requests natively.

This can be controlled by providing the `method` parameter with a string or array defining one or more of the following methods.

```
GET | HEAD | POST | PUT | DELETE | CONNECT | OPTIONS | TRACE | PATCH
```

```ts
server.route('/test/route', (req, url) => {
	if (req.method === 'GET')
		// Handle GET request.
	else if (req.method === 'POST')
		// Handle POST request.
}, ['GET', 'POST']);
```

> [!NOTE]
> Routes defined with .sse() or .webhook() are always registered as 'GET' and 'POST' respectively and cannot be configured.

### Redirection Routes

`spooder` does not provide a built-in redirection handler since it's trivial to implement one using [`Response.redirect`](https://developer.mozilla.org/en-US/docs/Web/API/Response/redirect_static), part of the standard Web API.

```ts
server.route('/redirect', () => Response.redirect('/redirected', 301));
```

### Status Code Text

`spooder` exposes `HTTP_STATUS_CODE` to convieniently access status code text.

```ts
import { HTTP_STATUS_CODE } from 'spooder';

server.default((req, status_code) => {
	// status_code: 404
	// Body: Not Found
	return new Response(HTTP_STATUS_CODE[status_code], { status: status_code });
});
```

### RequestHandler

`RequestHandler` is a function that accepts a [`Request`](https://developer.mozilla.org/en-US/docs/Web/API/Request) object and a [`URL`](https://developer.mozilla.org/en-US/docs/Web/API/URL) object and returns a `HandlerReturnType`.

`HandlerReturnType` must be one of the following.

| Type | Description |
| --- | --- |
| `Response` | https://developer.mozilla.org/en-US/docs/Web/API/Response |
| `Blob` | https://developer.mozilla.org/en-US/docs/Web/API/Blob |
| `BunFile` | https://bun.sh/docs/api/file-io |
| `object` | Will be serialized to JSON. |
| `string` | Will be sent as `text/html``. |
| `number` | Sets status code and sends status message as plain text. |

> [!NOTE]
> For custom JSON serialization on an object/class, implement the [`toJSON()`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify) method.

`HandleReturnType` can also be a promise resolving to any of the above types, which will be awaited before sending the response.

> [!NOTE]
> Returning `Bun.file()` directly is the most efficient way to serve static files as it uses system calls to stream the file directly to the client without loading into user-space.

### Query Parameters

Query parameters can be accessed from the `searchParams` property on the `URL` object.

```ts
server.route('/test', (req, url) => {
	return new Response(url.searchParams.get('foo'), { status: 200 });
});
```

```http
GET /test?foo=bar HTTP/1.1

HTTP/1.1 200 OK
Content-Length: 3

bar
```

Named parameters can be used in paths by prefixing a path segment with a colon.

> [!IMPORTANT]
> Named parameters will overwrite existing query parameters with the same name.

```ts
server.route('/test/:param', (req, url) => {
	return new Response(url.searchParams.get('param'), { status: 200 });
});
```

### Wildcards

Wildcards can be used to match any path that starts with a given path.

> [!NOTE]
> If you intend to use this for directory serving, you may be better suited looking at the `server.dir()` function.

```ts
server.route('/test/*', (req, url) => {
	return new Response('Hello, world!', { status: 200 });
});
```

> [!IMPORTANT]
> Routes are [FIFO](https://en.wikipedia.org/wiki/FIFO_(computing_and_electronics)) and wildcards are greedy. Wildcards should be registered last to ensure they do not consume more specific routes.

```ts
server.route('/*', () => 301);
server.route('/test', () => 200);

// Accessing /test returns 301 here, because /* matches /test first.
```

### Fallback Handlers

### 🔧 `server.handle(status_code: number, handler: RequestHandler)`
Register a custom handler for a specific status code.
```ts
server.handle(500, (req) => {
	return new Response('Custom Internal Server Error Message', { status: 500 });
});
```

### 🔧 `server.default(handler: DefaultHandler)`
Register a handler for all unhandled response codes.
> [!NOTE]
> If you return a `Response` object from here, you must explicitly set the status code.
```ts
server.default((req, status_code) => {
	return new Response(`Custom handler for: ${status_code}`, { status: status_code });
});
```

### 🔧 `server.error(handler: ErrorHandler)`
Register a handler for uncaught errors.

> [!NOTE]
> Unlike other handlers, this should only return `Response` or `Promise<Response>`.
```ts
server.error((err, req, url) => {
	return new Response('Custom Internal Server Error Message', { status: 500 });
});
```

> [!IMPORTANT]
> It is highly recommended to use `caution()` or some form of reporting to notify you when this handler is called, as it means an error went entirely uncaught.

```ts
server.error((err, req, url) => {
	// Notify yourself of the error.
	caution({ err, url });

	// Return a response to the client.
	return new Response('Custom Internal Server Error Message', { status: 500 });
});
```

### Slow Requests

### 🔧 `server.on_slow_request(callback: SlowRequestCallback, threshold: number)`

`server.on_slow_request` can be used to register a callback for requests that take an undesirable amount of time to process.

By default requests that take longer than `1000ms` to process will trigger the callback, but this can be adjusted by providing a custom threshold.

> [!IMPORTANT]
> If your canary reports to a public repository, be cautious about directly including the `req` object in the callback. This can lead to sensitive information being leaked.

```ts
server.on_slow_request(async (req, time, url) => {
	// avoid `time` in the title to avoid canary spam
	// see caution() API for information
	await caution('Slow request warning', { req, time });
}, 500);
```

> [!NOTE]
> The callback is not awaited internally, so you can use `async/await` freely without blocking the server/request.

### 🔧 `server.allow_slow_request(req: Request)`

In some scenarios, mitigation throttling or heavy workloads may cause slow requests intentionally. To prevent these triggering a caution, requests can be marked as slow.

```ts
server.on_slow_request(async (req, time, url) => {
	await caution('Slow request warning', { req, time });
}, 500);

server.route('/test', async (req) => {
	// this request is marked as slow, therefore won't
	// trigger on_slow_request despite taking 5000ms+
	server.allow_slow_request(req);
	await new Promise(res => setTimeout(res, 5000));
});
```

> [!NOTE]
> This will have no effect if a handler hasn't been registered with `on_slow_request`.

<a id="api-http-directory"></a>
## HTTP > Directory Serving

### 🔧 `server.dir(path: string, dir: string, options?: DirOptions | DirHandler)`
Serve files from a directory.

```ts
server.dir('/content', './public/content');
```

> [!IMPORTANT]
> `server.dir` registers a wildcard route. Routes are [FIFO](https://en.wikipedia.org/wiki/FIFO_(computing_and_electronics)) and wildcards are greedy. Directories should be registered last to ensure they do not consume more specific routes.

```ts
server.dir('/', '/files');
server.route('/test', () => 200);

// Route / is equal to /* with server.dir()
// Accessing /test returns 404 here because /files/test does not exist.
```

#### Directory Options

You can configure directory behavior using the `DirOptions` interface:

```ts
interface DirOptions {
	ignore_hidden?: boolean;      // default: true
	index_directories?: boolean;  // default: false  
	support_ranges?: boolean;     // default: true
}
```

**Options-based configuration:**
```ts
// Enable directory browsing with HTML listings
server.dir('/files', './public', { index_directories: true });

// Serve hidden files and disable range requests
server.dir('/files', './public', { 
	ignore_hidden: false, 
	support_ranges: false 
});

// Full configuration
server.dir('/files', './public', { 
	ignore_hidden: true,
	index_directories: true,
	support_ranges: true 
});
```

When `index_directories` is enabled, accessing a directory will return a styled HTML page listing the directory contents with file and folder icons.

#### Custom Directory Handlers

For complete control, provide a custom handler function:

```ts
server.dir('/static', '/static', (file_path, file, stat, request, url) => {
	// ignore hidden files by default, return 404 to prevent file sniffing
	if (path.basename(file_path).startsWith('.'))
		return 404; // Not Found

	if (stat.isDirectory())
		return 401; // Unauthorized

	return http_apply_range(file, request);
});
```

| Parameter | Type | Reference |
| --- | --- | --- |
| `file_path` | `string` | The path to the file on disk. |
| `file` | `BunFile` | https://bun.sh/docs/api/file-io |
| `stat` | `fs.Stats` | https://nodejs.org/api/fs.html#class-fsstats |
| `request` | `Request` | https://developer.mozilla.org/en-US/docs/Web/API/Request |
| `url` | `URL` | https://developer.mozilla.org/en-US/docs/Web/API/URL |

Asynchronous directory handlers are supported and will be awaited.

```ts
server.dir('/static', '/static', async (file_path, file) => {
	let file_contents = await file.text();
	// do something with file_contents
	return file_contents;
});
```

> [!NOTE]
> The directory handler function is only called for files that exist on disk - including directories.

> [!NOTE]
> Uncaught `ENOENT` errors thrown from the directory handler will return a `404` response, other errors will return a `500` response.

### 🔧 `http_apply_range(file: BunFile, request: Request): HandlerReturnType`

`http_apply_range` parses the `Range` header for a request and slices the file accordingly. This is used internally by `server.dir()` and exposed for convenience.

```ts
server.route('/test', (req, url) => {
	const file = Bun.file('./test.txt');
	return http_apply_range(file, req);
});
```

```http
GET /test HTTP/1.1
Range: bytes=0-5

HTTP/1.1 206 Partial Content
Content-Length: 6
Content-Range: bytes 0-5/6
Content-Type: text/plain;charset=utf-8

Hello,
```

<a id="api-http-sse"></a>
## HTTP > Server-Sent Events (SSE)

### 🔧 `server.sse(path: string, handler: ServerSentEventHandler)`

Setup a [server-sent event](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) stream.

```ts
server.sse('/sse', (req, url, client) => {
	client.message('Hello, client!'); // Unnamed event.
	client.event('named_event', 'Hello, client!'); // Named event.

	client.message(JSON.stringify({ foo: 'bar' })); // JSON message.
});
```

`client.closed` is a promise that resolves when the client closes the connection.

```ts
const clients = new Set();

server.sse('/sse', (req, url, client) => {
	clients.add(client);
	client.closed.then(() => clients.delete(client));
});
```

Connections can be manually closed with `client.close()`. This will also trigger the `client.closed` promise to resolve.

```ts
server.sse('/sse', (req, url, client) => {
	client.message('Hello, client!');

	setTimeout(() => {
		client.message('Goodbye, client!');
		client.close();
	}, 5000);
});
```

<a id="api-http-webhooks"></a>
## HTTP > Webhooks

### 🔧 `server.webhook(secret: string, path: string, handler: WebhookHandler)`

Setup a webhook handler.

```ts
server.webhook(process.env.WEBHOOK_SECRET, '/webhook', payload => {
	// React to the webhook.
	return 200;
});
```

A webhook callback will only be called if the following critera is met by a request:
- Request method is `POST` (returns `405` otherwise)
- Header `X-Hub-Signature-256` is present (returns `400` otherwise)
- Header `Content-Type` is `application/json` (returns `401` otherwise)
- Request body is a valid JSON object (returns `500` otherwise)
- HMAC signature of the request body matches the `X-Hub-Signature-256` header (returns `401` otherwise)

> [!NOTE]
> Constant-time comparison is used to prevent timing attacks when comparing the HMAC signature.

<a id="api-http-websockets"></a>
## HTTP > Websocket Server

### 🔧 `server.websocket(path: string, handlers: WebSocketHandlers)`

Register a route which handles websocket connections.

```ts
server.websocket('/path/to/websocket', {
	// all of these handlers are OPTIONAL

	accept: (req) => {
		// validates a request before it is upgraded
		// returns HTTP 401 if FALSE is returned
		// allows you to check headers/authentication

		// if an OBJECT is returned, the object will
		// be accessible on the websocket as ws.data.*

		return true;
	},

	open: (ws) => {
		// called when a websocket client connects
	},

	close: (ws, code, reason) => {
		// called when a websocket client disconnects
	},

	message: (ws, message) => {
		// called when a websocket message is received
		// message is a string
	},

	message_json: (ws, data) => {
		// called when a websocket message is received
		// payload is parsed as JSON

		// if payload cannot be parsed, socket will be
		// closed with error 1003: Unsupported Data

		// messages are only internally parsed if this
		// handler is present
	},

	drain: (ws) => {
		// called when a websocket with backpressure drains
	}
});
```

> [!IMPORTANT]
> While it is possible to register multiple routes for websockets, the only handler which is unique per route is `accept()`. The last handlers provided to any route (with the exception of `accept()`) will apply to ALL websocket routes. This is a limitation in Bun.

<a id="api-error-handling"></a>
## API > Error Handling

### 🔧 `ErrorWithMetadata(message: string, metadata: object)`

The `ErrorWithMetadata` class allows you to attach metadata to errors, which can be used for debugging purposes when errors are dispatched to the canary.

```ts
throw new ErrorWithMetadata('Something went wrong', { foo: 'bar' });
```

Functions and promises contained in the metadata will be resolved and the return value will be used instead.

```ts
throw new ErrorWithMetadata('Something went wrong', { foo: () => 'bar' });
```

### 🔧 `caution(err_message_or_obj: string | object, ...err: object[]): Promise<void>`

Raise a warning issue on GitHub. This is useful for non-fatal issues which you want to be notified about.

> [!NOTE]
> This function is only available if the canary feature is enabled.

```ts
try {
	// Perform a non-critical action, such as analytics.
	// ...
} catch (e) {
	// `caution` is async, you can use it without awaiting.
	caution(e);
}
```

Additional data can be provided as objects which will be serialized to JSON and included in the report.

```ts
caution(e, { foo: 42 });
```

A custom error message can be provided as the first parameter

> [!NOTE]
> Avoid including dynamic information in the title that would prevent the issue from being unique.

```ts
caution('Custom error', e, { foo: 42 });
```

Issues raised with `caution()` are rate-limited. By default, the rate limit is `86400` seconds (24 hours), however this can be configured in the `spooder.canary.throttle` property.

```json
{
	"spooder": {
		"canary": {
			"throttle": 86400
		}
	}
}
```

Issues are considered unique by the `err_message` parameter, so avoid using dynamic information that would prevent this from being unique.

If you need to provide unique information, you can use the `err` parameter to provide an object which will be serialized to JSON and included in the issue body.

```ts
const some_important_value = Math.random();

// Bad: Do not use dynamic information in err_message.
await caution('Error with number ' + some_important_value);

// Good: Use err parameter to provide dynamic information.
await caution('Error with number', { some_important_value });
```

### 🔧 `panic(err_message_or_obj: string | object, ...err: object[]): Promise<void>`

This behaves the same as `caution()` with the difference that once `panic()` has raised the issue, it will exit the process with a non-zero exit code.

> [!NOTE]
> This function is only available if the canary feature is enabled.

This should only be used as an absolute last resort when the server cannot continue to run and will be unable to respond to requests.

```ts
try {
	// Perform a critical action.
	// ...
} catch (e) {
	// You should await `panic` since the process will exit.
	await panic(e);
}
```

### 🔧 `safe(fn: Callable): Promise<void>`

`safe()` is a utility function that wraps a "callable" and calls `caution()` if it throws an error.

> [!NOTE]
> This utility is primarily intended to be used to reduce boilerplate for fire-and-forget functions that you want to be notified about if they fail. 

```ts
safe(async (() => {
	// This code will run async and any errors will invoke caution().
});
```

`safe()` supports both async and sync callables, as well as Promise objects. `safe()` can also used with `await`.

```ts
await safe(() => {
	return new Promise((resolve, reject) => {
		// Do stuff.
	});
});
```

### 🔧 `set_error_mode(mode: ERR_MODE): void`

Set the global error handling mode for spooder APIs. This affects how errors are handled across all spooder components including database interfaces and worker event pipes.

```ts
import { set_error_mode, ERR_MODE } from 'spooder';

// Default - suppress errors, return fallback values
set_error_mode(ERR_MODE.SILENT_FAILURE);

// Throw exceptions on errors
set_error_mode(ERR_MODE.THROW_EXCEPTION);

// Suppress errors but raise caution reports
set_error_mode(ERR_MODE.CANARY_CAUTION);
```

### 🔧 `get_error_mode(): ERR_MODE`

Get the current global error handling mode.

```ts
import { get_error_mode, ERR_MODE } from 'spooder';

const current_mode = get_error_mode();
if (current_mode === ERR_MODE.CANARY_CAUTION) {
	// Handle caution mode logic
}
```

<a id="api-workers"></a>
## API > Workers

### 🔧 `worker_event_pipe(worker: Worker | typeof self): WorkerEventPipe`

Create an event-based communication pipe between host and worker processes. This function works both inside and outside of workers and provides a simple event system on top of the native `postMessage` API.

```ts
// main thread
const worker = new Worker('./some_file.ts');
const pipe = worker_event_pipe(worker);

pipe.on('bar', data => console.log('Received from worker:', data));
pipe.send('foo', { x: 42 });

// worker thread
import { worker_event_pipe } from 'spooder';

const pipe = worker_event_pipe(globalThis as unknown as Worker);

pipe.on('foo', data => {
	console.log('Received from main:', data); // { x: 42 }
	pipe.send('bar', { response: 'success' });
});
```

### 🔧 `pipe.send(id: string, data?: object): void`

Send a message to the other side of the worker pipe with the specified event ID and optional data payload.

```ts
pipe.send('user_update', { user_id: 123, name: 'John' });
pipe.send('simple_event'); // data defaults to {}
```

### 🔧 `pipe.on(event: string, callback: (data: object) => void | Promise<void>): void`

Register an event handler for messages with the specified event ID. The callback can be synchronous or asynchronous.

```ts
pipe.on('process_data', async (data) => {
	const result = await processData(data);
	pipe.send('data_processed', { result });
});

pipe.on('log_message', (data) => {
	console.log(data.message);
});
```

> [!NOTE]
> There can only be one event handler for a specific event ID. Registering a new handler for an existing event ID will overwrite the previous handler.

### 🔧 `pipe.once(event: string, callback: (data: object) => void | Promise<void>): void`

Register an event handler for messages with the specified event ID. This is the same as `pipe.on`, except the handler is automatically removed once it is fired.

```ts
pipe.once('one_time_event', async (data) => {
	// this will only fire once
});
```

### 🔧 `pipe.off(event: string): void`

Unregister an event handler for events with the specified event ID.

```ts
pipe.off('event_name');
```

> [!NOTE]
> Worker event pipes use the global error handling mode. Errors in message handling will be handled according to the current `error_mode` setting (silent failure, throw exception, or canary caution).

> [!IMPORTANT]
> Each worker pipe instance expects to be the sole handler for the worker's message events. Creating multiple pipes for the same worker may result in unexpected behavior.

<a id="api-caching"></a>
## API > Caching

### 🔧 `cache_http(options?: CacheOptions)`

Initialize a file caching system that stores file contents in memory with configurable TTL, size limits, and ETag support for efficient HTTP caching.

```ts
import { cache_http } from 'spooder';

const cache = cache_http({
	ttl: 5 * 60 * 1000 // 5 minutes
});

// Use with server routes
server.route('/', cache.serve('./index.html'));
```

The `cache_http()` function returns an object with a `serve()` method that can be used as a route handler for serving cached files.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `ttl` | `number` | `18000000` (5 hours) | Time in milliseconds before cached entries expire |
| `max_size` | `number` | `5242880` (5 MB) | Maximum total size of all cached files in bytes |
| `use_etags` | `boolean` | `true` | Generate and use ETag headers for cache validation |
| `headers` | `Record<string, string>` | `{}` | Additional HTTP headers to include in responses |
| `canary_report` | `boolean` | `false` | Reports faults to canary (see below).

#### Canary Reporting

If `canary_report` is enabled, `spooder` will call `caution()` in two scenarios:

1. The cache has exceeded it's maximum capacity and had to purge. If this happens frequently, it is an indication that the maximum capacity should be increased or the use of the cache should be evaluated.
2. An item cannot enter the cache because it's size is larger than the total size of the cache. This is an indication that either something too large is being cached, or the maximum capacity is far too small.

#### Cache Behavior

- Files are cached for the specified TTL duration.
- Individual files larger than `max_size` will not be cached
- When total cache size exceeds `max_size`, expired entries are removed first
- If still over limit, least recently used (LRU) entries are evicted

**ETag Support:**
- When `use_etags` is enabled, SHA-256 hashes are generated for file contents
- ETags enable HTTP 304 Not Modified responses for unchanged files
- Clients can send `If-None-Match` headers for efficient cache validation

> [!IMPORTANT]
> The cache uses memory storage and will be lost when the server restarts. It's designed for improving response times of frequently requested files rather than persistent storage.

> [!NOTE]
> Files are only cached after the first request. The cache performs lazy loading and does not pre-populate files on initialization.

<a id="api-templating"></a>
## API > Templating

### 🔧 `parse_template(template: string, replacements: Replacements, drop_missing: boolean): Promise<string>`

Replace placeholders in a template string with values from a replacement object.

```ts
const template = `
	<html>
		<head>
			<title>{{title}}</title>
		</head>
		<body>
			<h1>{{title}}</h1>
			<p>{{content}}</p>
			<p>{{ignored}}</p>
		</body>
	</html>
`;

const replacements = {
	title: 'Hello, world!',
	content: 'This is a test.'
};

const html = await parse_template(template, replacements);
```

```html
<html>
	<head>
		<title>Hello, world!</title>
	</head>
	<body>
		<h1>Hello, world!</h1>
		<p>This is a test.</p>
		<p>{{ignored}}</p>
	</body>
</html>
```

By default, placeholders that do not appear in the replacement object will be left as-is. Set `drop_missing` to `true` to remove them.

```ts
await parse_template(template, replacements, true);
```

```html
<html>
	<head>
		<title>Hello, world!</title>
	</head>
	<body>
		<h1>Hello, world!</h1>
		<p>This is a test.</p>
		<p></p>
	</body>
</html>
```

`parse_template` supports passing a function instead of a replacement object. This function will be called for each placeholder and the return value will be used as the replacement. This function can be a Promise/async function.

```ts
const replacer = (placeholder: string) => {
	return placeholder.toUpperCase();
};

await parse_template('Hello {{world}}', replacer);
```

```html
<html>
	<head>
		<title>TITLE</title>
	</head>
	<body>
		<h1>TITLE</h1>
		<p>CONTENT</p>
		<p>IGNORED</p>
	</body>
</html>
```

`parse_template` supports conditional rendering with the following syntax.

```html
<t-if test="foo">I love {{foo}}</t-if>
```
Contents contained inside a `t-if` block will be rendered providing the given value, in this case `foo` is truthy in the substitution table.

A `t-if` block is only removed if `drop_missing` is `true`, allowing them to persist through multiple passes of a template.


`parse_template` supports looping arrays and objects using the `items` and `as` attributes.

#### Object/Array Looping with `items` and `as` Attributes

```html
<t-for items="items" as="item"><div>{{item.name}}: {{item.value}}</div></t-for>
```

```ts
const template = `
	<ul>
		<t-for items="colors" as="color">
			<li class="{{color.type}}">
				{{color.name}}
			</li>
		</t-for>
	</ul>
`;

const replacements = {
	colors: [
		{ name: 'red', type: 'warm' },
		{ name: 'blue', type: 'cool' },
		{ name: 'green', type: 'neutral' }
	]
};

const html = await parse_template(template, replacements);
```

```html
<ul>
	<li class="warm">red</li>
	<li class="cool">blue</li>
	<li class="neutral">green</li>
</ul>
```

#### Dot Notation Property Access

You can access nested object properties using dot notation:

```ts
const data = {
	user: {
		profile: { name: 'John', age: 30 },
		settings: { theme: 'dark' }
	}
};

await parse_template('Hello {{user.profile.name}}, you prefer {{user.settings.theme}} mode!', data);
// Result: "Hello John, you prefer dark mode!"
```

All placeholders inside a `<t-for>` loop are substituted, but only if the loop variable exists.

In the following example, `missing` does not exist, so `test` is not substituted inside the loop, but `test` is still substituted outside the loop.

```html
<div>Hello {{test}}!</div>
<t-for items="missing" as="item">
	<div>Loop {{test}}</div>
</t-for>
```

```ts
await parse_template(..., {
	test: 'world'
});
```

```html
<div>Hello world!</div>
<t-for items="missing" as="item">
	<div>Loop {{test}}</div>
</t-for>
```

### 🔧 `generate_hash_subs(length: number, prefix: string, hashes?: Record<string, string>): Promise<Record<string, string>>`

Generate a replacement table for mapping file paths to hashes in templates. This is useful for cache-busting static assets.

> [!IMPORTANT]
> Internally `generate_hash_subs()` uses `git ls-tree -r HEAD`, so the working directory must be a git repository.

```ts
let hash_sub_table = {};

generate_hash_subs().then(subs => hash_sub_table = subs).catch(caution);

server.route('/test', (req, url) => {
	return parse_template('Hello world {{hash=docs/project-logo.png}}', hash_sub_table);
});
```

```html
Hello world 754d9ea
```

> [!IMPORTANT]
> Specify paths as they appear in git, relative to the repository root and with forward slashes (no leading slash).

By default hashes are truncated to `7` characters (a short hash), a custom length can be provided instead.

```ts
generate_hash_subs(40).then(...);
// d65c52a41a75db43e184d2268c6ea9f9741de63e
```

> [!NOTE]
> SHA-1 hashes are `40` characters. Git is transitioning to SHA-256, which are `64` characters. Short hashes of `7` are generally sufficient for cache-busting.

Use a different prefix other than `hash=` by passing it as the first parameter.

```ts
generate_hash_subs(7, '$#').then(subs => hash_sub_table = subs).catch(caution);

server.route('/test', (req, url) => {
	return parse_template('Hello world {{$#docs/project-logo.png}}', hash_sub_table);
});
```

### 🔧 ``get_git_hashes(length: number): Promise<Record<string, string>>``

Internally, `generate_hash_subs()` uses `get_git_hashes()` to retrieve the hash table from git. This function is exposed for convenience.

> [!IMPORTANT]
> Internally `get_git_hashes()` uses `git ls-tree -r HEAD`, so the working directory must be a git repository.

```ts
const hashes = await get_git_hashes(7);
// { 'docs/project-logo.png': '754d9ea' }
```

If you're using `generate_hash_subs()` and `get_git_hashes()` at the same time, it is more efficient to pass the result of `get_git_hashes()` directly to `generate_hash_subs()` to prevent redundant calls to git.

```ts
const hashes = await get_git_hashes(7);
const subs = await generate_hash_subs(7, undefined, hashes);

// hashes[0] -> { 'docs/project-logo.png': '754d9ea' }
// subs[0] -> { 'hash=docs/project-logo.png': '754d9ea' }
```

<a id="api-database"></a>
<a id="api-database-interface"></a>

### 🔧 ``db_cast_set<T extends string>(set: string | null): Set<T>``

Takes a database SET string and returns a `Set<T>` where `T` is a provided enum.

```ts
enum ExampleRow {
	OPT_A = 'OPT_A',
	OPT_B = 'OPT_B',
	OPT_C = 'OPT_C'
};

const set = db_cast_set<ExampleRow>('OPT_A,OPT_B');
if (set.has(ExampleRow.OPT_B)) {
	// ...
}
```

### 🔧 ``db_serialize_set<T extends string>(set: Set<T> | null): string``

Takes a `Set<T>` and returns a database SET string. If the set is empty or `null`, it returns an empty string.

```ts
enum ExampleRow {
	OPT_A = 'OPT_A',
	OPT_B = 'OPT_B',
	OPT_C = 'OPT_C'
};

const set = new Set<ExampleRow>([ExampleRow.OPT_A, ExampleRow.OPT_B]);

const serialized = db_serialize_set(set);
// > 'OPT_A,OPT_B'
```



<a id="api-database-interface-sqlite"></a>
## API > Database > Interface > SQLite

`spooder` provides a simple **SQLIte** interface that acts as a wrapper around the Bun SQLite API. The construction parameters match the underlying API.

```ts
// see: https://bun.sh/docs/api/sqlite
const db = db_sqlite(':memory:', { create: true });
db.instance; // raw access to underlying sqlite instance.
```

### 🔧 ``db_sqlite.update_schema(schema_dir: string, schema_table: string): Promise<void>``

`spooder` offers a database schema management system. The `update_schema()` function is a shortcut to call this on the underlying database.

See [API > Database > Schema](#api-database-schema) for information on how schema updating works.

```ts
// without interface
import { db_sqlite, db_update_schema_sqlite } from 'spooder';
const db = db_sqlite('./my_database.sqlite');
await db_update_schema_sqlite(db.instance, './schema');

// with interface
import { db_sqlite } from 'spooder';
const db = db_sqlite('./my_database.sqlite');
await db.update_schema('./schema');
```

### 🔧 ``db_sqlite.insert(sql: string, ...values: any): number``

Executes a query and returns the `lastInsertRowid`. Returns `-1` in the event of an error or if `lastInsertRowid` is not provided.

```ts
const id = db.insert('INSERT INTO users (name) VALUES(?)', 'test');
```

### 🔧 ``db_sqlite.insert_object(table: string, obj: Record<string, any>): number``

Executes an insert query using object key/value mapping and returns the `lastInsertRowid`. Returns `-1` in the event of an error.

```ts
const id = db.insert_object('users', { name: 'John', email: 'john@example.com' });
```

### 🔧 ``db_sqlite.execute(sql: string, ...values: any): number``

Executes a query and returns the number of affected rows. Returns `-1` in the event of an error.

```ts
const affected = db.execute('UPDATE users SET name = ? WHERE id = ?', 'Jane', 1);
```

### 🔧 ``db_sqlite.get_all<T>(sql: string, ...values: any): T[]``

Returns the complete query result set as an array. Returns empty array if no rows found or if query fails.

```ts
const users = db.get_all<User>('SELECT * FROM users WHERE active = ?', true);
```

### 🔧 ``db_sqlite.get_single<T>(sql: string, ...values: any): T | null``

Returns the first row from a query result set. Returns `null` if no rows found or if query fails.

```ts
const user = db.get_single<User>('SELECT * FROM users WHERE id = ?', 1);
```

### 🔧 ``db_sqlite.get_column<T>(sql: string, column: string, ...values: any): T[]``

Returns the query result as a single column array. Returns empty array if no rows found or if query fails.

```ts
const names = db.get_column<string>('SELECT name FROM users', 'name');
```

### 🔧 ``db_sqlite.get_paged<T>(sql: string, values?: any[], page_size?: number): AsyncGenerator<T[]>``

Returns an async iterator that yields pages of database rows. Each page contains at most `page_size` rows (default 1000).

```ts
for await (const page of db.get_paged<User>('SELECT * FROM users', [], 100)) {
	console.log(`Processing ${page.length} users`);
}
```

### 🔧 ``db_sqlite.count(sql: string, ...values: any): number``

Returns the value of `count` from a query. Returns `0` if query fails.

```ts
const user_count = db.count('SELECT COUNT(*) AS count FROM users WHERE active = ?', true);
```

### 🔧 ``db_sqlite.count_table(table_name: string): number``

Returns the total count of rows from a table. Returns `0` if query fails.

```ts
const total_users = db.count_table('users');
```

### 🔧 ``db_sqlite.exists(sql: string, ...values: any): boolean``

Returns `true` if the query returns any results. Returns `false` if no results found or if query fails.

```ts
const has_active_users = db.exists('SELECT 1 FROM users WHERE active = ? LIMIT 1', true);
```

### 🔧 ``db_sqlite.transaction(scope: (transaction: SQLiteDatabaseInterface) => void | Promise<void>): boolean``

Executes a callback function within a database transaction. The callback receives a transaction object with all the same database methods available. Returns `true` if the transaction was committed successfully, `false` if it was rolled back due to an error.

```ts
const success = db.transaction(async (tx) => {
	const user_id = tx.insert('INSERT INTO users (name) VALUES (?)', 'John');
	tx.insert('INSERT INTO user_profiles (user_id, bio) VALUES (?, ?)', user_id, 'Hello world');
});

if (success) {
	console.log('Transaction completed successfully');
} else {
	console.log('Transaction was rolled back');
}
```

<a id="api-database-interface-mysql"></a>
## API > Database > Interface > MySQL

`spooder` provides a simple **MySQL** interface that acts as a wrapper around the `mysql2` API. The connection options match the underlying API.

> [!IMPORTANT]
> MySQL requires the optional dependency `mysql2` to be installed - this is not automatically installed with spooder. This will be replaced when bun:sql supports MySQL natively.

```ts
// see: https://github.com/mysqljs/mysql#connection-options
const db = await db_mysql({
	// ...
});
db.instance; // raw access to underlying mysql2 instance.
```

### 🔧 ``db_mysql.update_schema(schema_dir: string, schema_table: string): Promise<void>``

`spooder` offers a database schema management system. The `update_schema()` function is a shortcut to call this on the underlying database.

See [API > Database > Schema](#api-database-schema) for information on how schema updating works.

```ts
// without interface
import { db_mysql, db_update_schema_mysql } from 'spooder';
const db = await db_mysql({ ... });
await db_update_schema_mysql(db.instance, './schema');

// with interface
import { db_mysql } from 'spooder';
const db = await db_mysql({ ... });
await db.update_schema('./schema');
```

### 🔧 ``db_mysql.insert(sql: string, ...values: any): Promise<number>``

Executes a query and returns the `LAST_INSERT_ID`. Returns `-1` in the event of an error or if `LAST_INSERT_ID` is not provided.

```ts
const id = await db.insert('INSERT INTO tbl (name) VALUES(?)', 'test');
```

### 🔧 ``db_mysql.insert_object(table: string, obj: Record<string, any>): Promise<number>``

Executes an insert query using object key/value mapping and returns the `LAST_INSERT_ID`. Returns `-1` in the event of an error.

```ts
const id = await db.insert_object('users', { name: 'John', email: 'john@example.com' });
```

### 🔧 ``db_mysql.execute(sql: string, ...values: any): Promise<number>``

Executes a query and returns the number of affected rows. Returns `-1` in the event of an error.

```ts
const affected = await db.execute('UPDATE users SET name = ? WHERE id = ?', 'Jane', 1);
```

### 🔧 ``db_mysql.get_all<T>(sql: string, ...values: any): Promise<T[]>``

Returns the complete query result set as an array. Returns empty array if no rows found or if query fails.

```ts
const users = await db.get_all<User>('SELECT * FROM users WHERE active = ?', true);
```

### 🔧 ``db_mysql.get_single<T>(sql: string, ...values: any): Promise<T | null>``

Returns the first row from a query result set. Returns `null` if no rows found or if query fails.

```ts
const user = await db.get_single<User>('SELECT * FROM users WHERE id = ?', 1);
```

### 🔧 ``db_mysql.get_column<T>(sql: string, column: string, ...values: any): Promise<T[]>``

Returns the query result as a single column array. Returns empty array if no rows found or if query fails.

```ts
const names = await db.get_column<string>('SELECT name FROM users', 'name');
```

### 🔧 ``db_mysql.call<T>(func_name: string, ...args: any): Promise<T[]>``

Calls a stored procedure and returns the result set as an array. Returns empty array if no rows found or if query fails.

```ts
const results = await db.call<User>('get_active_users', true, 10);
```

### 🔧 ``db_mysql.get_paged<T>(sql: string, values?: any[], page_size?: number): AsyncGenerator<T[]>``

Returns an async iterator that yields pages of database rows. Each page contains at most `page_size` rows (default 1000).

```ts
for await (const page of db.get_paged<User>('SELECT * FROM users', [], 100)) {
	console.log(`Processing ${page.length} users`);
}
```

### 🔧 ``db_mysql.count(sql: string, ...values: any): Promise<number>``

Returns the value of `count` from a query. Returns `0` if query fails.

```ts
const user_count = await db.count('SELECT COUNT(*) AS count FROM users WHERE active = ?', true);
```

### 🔧 ``db_mysql.count_table(table_name: string): Promise<number>``

Returns the total count of rows from a table. Returns `0` if query fails.

```ts
const total_users = await db.count_table('users');
```

### 🔧 ``db_mysql.exists(sql: string, ...values: any): Promise<boolean>``

Returns `true` if the query returns any results. Returns `false` if no results found or if query fails.

```ts
const has_active_users = await db.exists('SELECT 1 FROM users WHERE active = ? LIMIT 1', true);
```

### 🔧 ``db_mysql.transaction(scope: (transaction: MySQLDatabaseInterface) => void | Promise<void>): Promise<boolean>``

Executes a callback function within a database transaction. The callback receives a transaction object with all the same database methods available. Returns `true` if the transaction was committed successfully, `false` if it was rolled back due to an error.

```ts
const success = await db.transaction(async (tx) => {
	const user_id = await tx.insert('INSERT INTO users (name) VALUES (?)', 'John');
	await tx.insert('INSERT INTO user_profiles (user_id, bio) VALUES (?, ?)', user_id, 'Hello world');
});

if (success) {
	console.log('Transaction completed successfully');
} else {
	console.log('Transaction was rolled back');
}
```

<a id="api-database-schema"></a>
## API > Database > Schema

`spooder` provides a straightforward API to manage database schema in revisions through source control.

```ts
// sqlite
db_update_schema_sqlite(db: Database, schema_dir: string, schema_table?: string): Promise<void>;

// mysql
db_update_schema_mysql(db: Connection, schema_dir: string, schema_table?: string): Promise<void>;
```

```ts
// sqlite example
import { db_update_schema_sqlite } from 'spooder';
import { Database } from 'bun:sqlite';

const db = new Database('./database.sqlite');
await db_update_schema_sqlite(db, './schema');
```

```ts
// mysql example
import { db_update_schema_mysql } from 'spooder';
import mysql from 'mysql2';

const db = await mysql.createConnection({
	// connection options
	// see https://github.com/mysqljs/mysql#connection-options
});
await db_update_schema_mysql(db, './schema');
```

> [!IMPORTANT]
> MySQL requires the optional dependency `mysql2` to be installed - this is not automatically installed with spooder. This will be replaced when bun:sql supports MySQL natively.

### Interface API

If you are already using the [database interface API](#api-database-interface) provided by `spooder`, you can call `update_schema()` directly on the interface.

```ts
const db = await db_mysql({ ... });
await db.update_schema('./schema');
```

### Schema Files

The schema directory is expected to contain an SQL file for each table in the database with the file name matching the name of the table.

> [!NOTE]
> The schema directory is searched recursively and files without the `.sql` extension (case-insensitive) will be ignored.

```
- database.sqlite
- schema/
	- users.sql
	- posts.sql
	- comments.sql
```

```ts
import { db_update_schema_sqlite } from 'spooder';
import { Database } from 'bun:sqlite';

const db = new Database('./database.sqlite');
await db_update_schema_sqlite(db, './schema');
```

Each of the SQL files should contain all of the revisions for the table, with the first revision being table creation and subsequent revisions being table modifications.

```sql
-- [1] Table creation.
CREATE TABLE users (
	id INTEGER PRIMARY KEY,
	username TEXT NOT NULL,
	password TEXT NOT NULL
);

-- [2] Add email column.
ALTER TABLE users ADD COLUMN email TEXT;

-- [3] Cleanup invalid usernames.
DELETE FROM users WHERE username = 'admin';
DELETE FROM users WHERE username = 'root';
```

Each revision should be clearly marked with a comment containing the revision number in square brackets. Anything proceeding the revision number is treated as a comment and ignored.

>[!NOTE]
> The exact revision header syntax is `^--\s*\[(\d+)\]`.

Everything following a revision header is considered part of that revision until the next revision header or the end of the file, allowing for multiple SQL statements to be included in a single revision.

When calling `db_update_schema_*`, unapplied revisions will be applied in ascending order (regardless of order within the file) until the schema is up-to-date.

It is acceptable to omit keys. This can be useful to prevent repitition when managing stored procedures, views or functions.

```sql
-- example of repetitive declaration

-- [1] create view
CREATE VIEW `view_test` AS SELECT * FROM `table_a` WHERE col = 'foo';

-- [2] change view
DROP VIEW IF EXISTS `view_test`;
CREATE VIEW `view_test` AS SELECT * FROM `table_b` WHERE col = 'foo';
```
Instead of unnecessarily including each full revision of a procedure, view or function in the schema file, simply store the most up-to-date one and increment the version.
```sql
-- [2] create view
CREATE OR REPLACE VIEW `view_test` AS SELECT * FROM `table_b` WHERE col = 'foo';
```


Schema revisions are tracked in a table called `db_schema` which is created automatically if it does not exist with the following schema.

```sql
CREATE TABLE db_schema (
	db_schema_table_name TEXT PRIMARY KEY,
	db_schema_version INTEGER
);
```

The table used for schema tracking can be changed if necessary by providing an alternative table name as the third paramater.

```ts
await db_update_schema_sqlite(db, './schema', 'my_schema_table');
```

>[!IMPORTANT]
> The entire process is transactional. If an error occurs during the application of **any** revision for **any** table, the entire process will be rolled back and the database will be left in the state it was before the update was attempted.

>[!IMPORTANT]
> `db_update_schema_*` will throw an error if the revisions cannot be parsed or applied for any reason. It is important you catch and handle appropriately.

```ts
try {
	const db = new Database('./database.sqlite');
	await db_update_schema_sqlite(db, './schema');
} catch (e) {
	// panic (crash) or gracefully continue, etc.
	await panic(e);
}
```

### Schema Dependencies
By default, schema files are executed in the order they are provided by the operating system (generally alphabetically).

If you have a schema file that depends on one or more other schema files to be executed before it (for example, using foreign keys), you can specify dependencies.

```sql
-- [deps] table_b_schema.sql, table_c_schema.sql
-- [1] create table_a
CREATE ...
```

>[!IMPORTANT]
> Cyclic or missing dependencies will throw an error.

<a id="api-utilities"></a>
## API > Utilities

### 🔧 ``filesize(bytes: number): string``

Returns a human-readable string representation of a file size in bytes.

```ts
filesize(512); // > "512 bytes"
filesize(1024); // > "1 kb"
filesize(1048576); // > "1 mb"
filesize(1073741824); // > "1 gb"
filesize(1099511627776); // > "1 tb"
```

## Legal
This software is provided as-is with no warranty or guarantee. The authors of this project are not responsible or liable for any problems caused by using this software or any part thereof. Use of this software does not entitle you to any support or assistance from the authors of this project.

The code in this repository is licensed under the ISC license. See the [LICENSE](LICENSE) file for more information.