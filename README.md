<p align="center"><img src="docs/project-logo.png"/></p>

# spooder &middot; ![typescript](https://img.shields.io/badge/language-typescript-blue) [![license badge](https://img.shields.io/github/license/Kruithne/spooder?color=yellow)](LICENSE) ![npm version](https://img.shields.io/npm/v/spooder?color=c53635) ![bun](https://img.shields.io/badge/runtime-bun-f9f1e1)

`spooder` is a purpose-built server solution that shifts away from the dependency hell of the Node.js ecosystem, with a focus on stability and performance, which is why:
- It is built using the [Bun](https://bun.sh/) runtime and not designed to be compatible with Node.js or other runtimes.
- It uses zero dependencies and only relies on code written explicitly for `spooder` or APIs provided by the Bun runtime, often implemented in native code.
- It provides streamlined APIs for common server tasks in a minimalistic way, without the overhead of a full-featured web framework.
- It does not aim to cover every use-case and is opinionated in its design to reduce complexity and overhead.

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

```json
{
	"spooder": {
		"auto_restart": 5000,
		"update": [
			"git pull",
			"bun install"
		],
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

> ℹ️ Configuration warnings **do not** raise `caution` events with the `spooder` canary functionality.

# CLI

The `CLI` component of `spooder` is a global command-line tool for running server processes. For convenience, it is recommended that you run this in a `screen` session.

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

## CLI > Auto Restart

> ℹ️ This feature is not enabled by default.

In the event that the server process exits, regardless of exit code, `spooder` can automatically restart it after a short delay. To enable this feature specify the restart delay in milliseconds as `auto_restart` in the configuration.

```json
{
	"spooder": {
		"auto_restart": 5000
	}
}
```

If set to `0`, the server will be restarted immediately without delay. If set to `-1`, the server will not be restarted at all.

## CLI > Auto Update

> ℹ️ This feature is not enabled by default.

When starting or restarting a server process, `spooder` can automatically update the source code in the working directory. To enable this feature, the necessary update commands can be provided in the configuration as an array of strings.

```json
{
	"spooder": {
		"update": [
			"git pull",
			"bun install"
		]
	}
}
```

Each command should be a separate entry in the array and will be executed in sequence. The server process will be started once all commands have resolved.

> ℹ️ Chainging commands using `&&` or `||` operators does not work.

If a command in the sequence fails, the remaining commands will not be executed, however the server will still be started. This is preferred over entering a restart loop or failing to start the server at all.

You can utilize this to automatically update your server in response to a webhook or other event by simply exiting the process.

```ts
// This is a psuedo-example, you will need to implement webhook handling yourself.
events.on('receive-webhook', () => {
	// <- Gracefully finish processing here.
	process.exit(0);
});
```

## CLI > Canary

> ℹ️ This feature is not enabled by default.

`canary` is a feature in `spooder` which allows server problems to be raised as issues in your repository on GitHub.

To enable this feature, you will need to configure a GitHub App and configure it:

### 1. Create a GitHub App

Create a new GitHub App either on your personal account or on an organization. The app will need the following permissions:

- **Issues** - Read & Write
- **Metadata** - Read-only

Once created, install the GitHub App to your account. The app will need to be given access to the repositories you want to use the canary feature with.

In addition to the **App ID** that is assigned automatically, you will also need to generate a **Private Key** for the app. This can be done by clicking the **Generate a private key** button on the app page.

> Note: The private keys provided by GitHub are in PKCS#1 format, but only PKCS#8 is supported. You can convert the key file with the following command.

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in private-key.pem -out private-key-pkcs8.key
```

Each server that intends to use the canary feature will need to have the private key installed somewhere the server process can access it.

### 2. Add package.json configuration

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

### 3. Setup environment variables

The following two environment variables must be defined on the server.

```
SPOODER_CANARY_APP_ID=1234
SPOODER_CANARY_KEY=/home/bond/.ssh/id_007_pcks8.key
```

`SPOODER_CANARY_APP_ID` is the **App ID** as shown on the GitHub App page.

`SPOODER_CANARY_KEY` is the path to the private key file in PKCS#8 format.

> ℹ️ Since `spooder` uses the Bun runtime, you can use the `.env.local` file in the project root directory to set these environment variables per-project.

### 4. Use canary

Once configured, `spooder` will automatically raise an issue when the server exits with a non-zero exit code. 

In addition, you can manually raise issues using the `spooder` API by calling `caution()` or `panic()`. More information about these functions can be found in the `API` section.

If `canary` has not been configured correctly, `spooder` will only print warnings to the console when it attempts to raise an issue.

> ❗ Consider testing the canary feature with the `caution()` function before relying on it for critical issues.

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

While this sanitization adds a layer of protection against information leaking, it does not catch everything. You should pay special attention to messages and objects provided to the canary to not unintentionally leak sensitive information.

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
		"version": "0.6.4",
		"rev": "f02561530fda1ee9396f51c8bc99b38716e38296"
	}
}
```

# API

`spooder` exposes a simple yet powerful API for developing servers. The API is designed to be minimal to leave control in the hands of the developer and not add overhead for features you may not need.

- [API > Serving](#api--serving)
	- [`serve(port: number): Server`](#serveport-number-server)
- [API > Routing](#api--routing)
	- [`server.route(path: string, handler: RequestHandler)`](#serverroutepath-string-handler-requesthandler)
	- [`server.redirect(path: string, redirect_url: string)`](#serverredirectpath-string-redirect_url-string)
	- [`server.handle(status_code: number, handler: RequestHandler)`](#serverhandlestatus_code-number-handler-requesthandler)
	- [`server.default(handler: DefaultHandler)`](#serverdefaulthandler-defaulthandler)
	- [`server.error(handler: ErrorHandler)`](#servererrorhandler-errorhandler)
	- [`server.dir(path: string, dir: string, options?: DirOptions)`](#serverdirpath-string-dir-string-options-diroptions)
- [API > Server Control](#api--server-control)
	- [`server.stop(method: ServerStop)`](#serverstopmethod-serverstop)
- [API > Error Handling](#api--error-handling)
	- [`ErrorWithMetadata(message: string, metadata: object)`](#errorwithmetadatamessage-string-metadata-object)
	- [`caution(err_message_or_obj: string | object, ...err: object[]): Promise<void>`](#cautionerr_message_or_obj-string--object-err-object-promisevoid)
	- [`panic(err_message_or_obj: string | object, ...err: object[]): Promise<void>`](#panicerr_message_or_obj-string--object-err-object-promisevoid)

## API > Serving

### `serve(port: number): Server`

Bootstrap a server on the specified port.

```ts
import { serve } from 'spooder';

const server = serve(8080);
```

By default, the server responds with:

```http
HTTP/1.1 404 Not Found
Content-Length: 9
Content-Type: text/plain;charset=utf-8

Not Found
```

## API > Routing

### 🔧 `server.route(path: string, handler: RequestHandler)`

Register a handler for a specific path.

```ts
server.route('/test/route', (req, url) => {
	return new Response('Hello, world!', { status: 200 });
});
```

Named parameters can be used in paths by prefixing a path segment with a colon.

> ℹ️ Named parameters will overwrite existing query parameters with the same name.

```ts
server.route('/test/:param', (req, url) => {
	return new Response(url.searchParams.get('param'), { status: 200 });
});
```

Wildcards can be used to match any path that starts with a given path.

> ℹ️ If you intend to use this for directory serving, you may be better suited looking at the `server.dir()` function.

```ts
server.route('/test/*', (req, url) => {
	return new Response('Hello, world!', { status: 200 });
});
```

Asynchronous handlers are supported by returning a `Promise` from the handler.

```ts
server.route('/test/route', async (req, url) => {
	return new Response('Hello, world!', { status: 200 });
});
```

Returning a `number` directly from the handler will be treated as a status code and will send a plain text response with the status message as the body.

```ts
server.route('/test/route', (req, url) => {
	return 500;
});
```
```http
HTTP/1.1 500 Internal Server Error
Content-Length: 21
Content-Type: text/plain;charset=utf-8

Internal Server Error
```

Returning a `Blob` such as `BunFile` directly from the handler will be treated as a file and will send the blob as the response body with the appropriate content type and length headers.

> ℹ️ Returning `Bun.file()` directly is the most efficient way to serve static files as it uses system calls to stream the file directly to the client without loading into user-space.

```ts
server.route('/test/route', (req, url) => {
	return Bun.file('test.png');
});
```
```http
HTTP/1.1 200 OK
Content-Length: 12345
Content-Type: image/png

<binary data>
```

Returning an `object` type such as an array or a plain object will be treated as JSON and will send the object as JSON with the appropriate content type and length headers.

```ts
server.route('/test/route', (req, url) => {
	return { message: 'Hello, world!' };
});
```
```http
HTTP/1.1 200 OK
Content-Length: 25
Content-Type: application/json;charset=utf-8

{"message":"Hello, world!"}
```

Since custom classes are also objects, you can also return a custom class instance and it will be serialized to JSON. To control the serialization process, you can implement the [`toJSON()`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify) method on your class.

```ts
class User {
	constructor(public name: string, public age: number) {}

	toJSON() {
		return {
			name: this.name,
			age: this.age,
		};
	}
}

server.route('/test/route', (req, url) => {
	return new User('Bob', 42);
});
```
```http
HTTP/1.1 200 OK
Content-Length: 25
Content-Type: application/json;charset=utf-8

{"name":"Bob","age":42}
```

### 🔧 `server.redirect(path: string, redirect_url: string)`
Redirect clients to a specified URL with the status code `301 Moved Permanently`.
```ts
server.route('/test/route', redirect('https://www.google.co.uk/'));
```

### 🔧 `server.handle(status_code: number, handler: RequestHandler)`
Register a custom handler for a specific status code.
```ts
server.handle(500, (req) => {
	return new Response('Custom Internal Server Error Message', { status: 500 });
});
```

### 🔧 `server.default(handler: DefaultHandler)`
Register a handler for all unhandled response codes.
> ℹ️ If you return a `Response` object from here, you must explicitly set the status code.
```ts
server.default((req, status_code) => {
	return new Response(`Custom handler for: ${status_code}`, { status: status_code });
});
```

### 🔧 `server.error(handler: ErrorHandler)`
Register a handler for uncaught errors.
> ℹ️ This handler does not accept asynchronous functions and must return a `Response` object.
```ts
server.error((req, err) => {
	return new Response('Custom Internal Server Error Message', { status: 500 });
});
```

### 🔧 `server.dir(path: string, dir: string, options?: DirOptions)`
Serve static files from a directory.
```ts
server.dir('/content', './public/content');
```

By default, spooder will use the following default handler for serving directories.

```ts
function default_directory_handler(file_path: string, file: DirFile, stat: DirStat): HandlerReturnType {
	// ignore hidden files by default, return 404 to prevent file sniffing
	if (path.basename(file_path).startsWith('.'))
		return 404; // Not Found

	if (stat.isDirectory())
		return 401; // Unauthorized

	return file;
}
```

> [!NOTE]
> Uncaught `ENOENT` errors throw from the directory handler will return a `404` response, other errors will return a `500` response.

Provide your own directory handler for fine-grained control.

| Parameter | Type | Reference |
| --- | --- | --- |
| `file_path` | `string` | The path to the file on disk. |
| `file` | `BunFile` | https://bun.sh/docs/api/file-io |
| `stat` | `fs.Stats` | https://nodejs.org/api/fs.html#class-fsstats |
| `request` | `Request` | https://developer.mozilla.org/en-US/docs/Web/API/Request |
| `url` | `URL` | https://developer.mozilla.org/en-US/docs/Web/API/URL |

```ts
server.dir('/static', '/static', (file_path, file, stat, request, url) => {
	// Implement custom logic.
	return file; // HandlerReturnType
});
```

> [!NOTE]
> The directory handler function is only called for files that exist on disk - including directories.

## API > Server Control

### 🔧 `server.stop(method: ServerStop)`

Stop the server process immediately, terminating all in-flight requests.

```ts
server.stop(ServerStop.IMMEDIATE);
```

Stop the server process gracefully, waiting for all in-flight requests to complete.

```ts
server.stop(ServerStop.GRACEFUL);
```

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

> ℹ️ This function is only available if the canary feature is enabled.

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

> ℹ️ Avoid including dynamic information in the title that would prevent the issue from being unique.

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

> ℹ️ This function is only available if the canary feature is enabled.

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

## Legal
This software is provided as-is with no warranty or guarantee. The authors of this project are not responsible or liable for any problems caused by using this software or any part thereof. Use of this software does not entitle you to any support or assistance from the authors of this project.

The code in this repository is licensed under the ISC license. See the [LICENSE](LICENSE) file for more information.