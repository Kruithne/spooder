<p align="center"><img src="docs/project-logo.png"/></p>

# Spooder &middot; ![typescript](https://img.shields.io/badge/language-typescript-blue) [![license badge](https://img.shields.io/github/license/Kruithne/spooder?color=yellow)](LICENSE) ![npm version](https://img.shields.io/npm/v/spooder?color=c53635) ![bun](https://img.shields.io/badge/runtime-bun-f9f1e1)

`spooder` is a purpose-built server solution written using the [Bun](https://bun.sh/) runtime.

### What does it do?

`spooder` consists of a command-line tool which provides automatic updating/restarting and canary functionality, and a building-block API for creating servers.

### Should I use it?

Probably not. You are free to use `spooder` if you fully understand the risks and limitations of doing so, however here is a list of things you should consider before using it:

⚠️ This is not a Node.js package. It is built using the [Bun](https://bun.sh/) runtime, which is still experimental as of writing.

⚠️ It is designed to be highly opinionated and is not intended to be a general-purpose server, so configuration is limited.

⚠️ It is not a full-featured web server and only provides the functionality as required for the projects it has been built for.

⚠️ It has not been battle-tested and may contain bugs or security issues. The authors of this project are not responsible for any problems caused by using this software.

# Installation

```bash
# Installing globally for CLI runner usage.
bun add spooder --global

# Install into local package for API usage.
bun add spooder
```

# Configuration

Both the runner and the API are configured in the same way by providing a `spooder` object in your `package.json` file.

```json
{
	"spooder": {
		"autoRestart": 5000,
		"run": "bun run index.ts",
		"update": [
			"git pull",
			"bun install"
		]
	}
}
```

If there are any issues with the provided configuration, a warning will be printed to the console but will not halt execution. `spooder` will always fall back to default values where invalid configuration is provided.

Configuration warnings **do not** raise `caution` events with the `spooder` canary functionality.

# Runner

`spooder` includes a global command-line tool for running servers. It is recommended that you run this in a `screen` session.

```bash
screen -S spooder # Create a new screen session
cd /var/www/my_server/
spooder
```

While the intended use of this runner is for web servers, it can be used to run anything. It provides two primary features: automatic updating and automatic restarting.

## Entry Point

`spooder` will attempt to launch the server from the current working directory using the command `bun run index.ts` as a default.

To customize this, provide an alternative command via the `run` configuration.

```json
{
	"spooder": {
		"run": "bun run my_server.ts"
	}
}
```

While `spooder` uses a `bun run` command by default, it is possible to use any command string.

## Auto Restart

In the event that the server exits (regardless of exit code), `spooder` can automatically restart it after a short delay. To enable this feature specify the restart delay in milliseconds as `autoRestart` in the configuration.

```json
{
	"spooder": {
		"autoRestart": 5000
	}
}
```

If set to `0`, the server will be restarted immediately without delay. If set to `-1`, the server will not be restarted at all.

## Auto Update

When starting your server, `spooder` can automatically update the source code in the working directory. To enable this feature, the necessary update commands can be provided in the configuration as an array of strings.

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

Commands will be executed in sequence, and the server will not be started until after the commands have resolved.

Each command should be a separate item in the array. Chaining commands in a single string using the `&&` or `||` operators will not work.

If a command in the sequence fails, the remaining commands will not be executed, however the server will still be started. This is preferred over entering a restart loop or failing to start the server at all.

As well as being executed when the server is first started, the `update` commands are also run when `spooder` automatically restarts the server after it exits.

You can utilize this to automatically update your server in response to a webhook or other event by simply exiting the process.

```ts
events.on('receive-webhook', () => {
	// <- Gracefully finish processing here.
	process.exit(0);
});
```

## Canary

`canary` is a feature in `spooder` which allows server problems to be raised as issues in your repository on GitHub.

To enable this feature, there are a couple of steps you need to take.

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

The repository name must in the format `owner/repo` (e.g. `facebook/react`).

The `labels` property can be used to provide a list of labels to automatically add to the issue. This property is optional and can be omitted.

### 3. Setup environment variables

The following two environment variables must be defined on the server.

```
SPOODER_CANARY_APP_ID=1234
SPOODER_CANARY_KEY=/home/bond/.ssh/id_007_pcks8.key
```

`SPOODER_CANARY_APP_ID` is the **App ID** as shown on the GitHub App page.
`SPOODER_CANARY_KEY` is the path to the private key file in PKCS#8 format.

### 4. Use canary

Once configured, `spooder` will automatically raise an issue when the server exits with a non-zero exit code. 

In addition, you can manually raise issues using the `spooder` API by calling `caution()` or `panic()`. More information about these functions can be found in the `API` section.

## Crash

It is recommended that you harden your server code against unexpected exceptions and use `panic()` and `caution()` to raise issues with selected diagnostic information.

In the event that the server does encounter an unexpected exception which causes it to exit with a non-zero exit code, `spooder` will automatically raise an issue on GitHub using the canary feature, if configured.

Since this issue has been caught externally, `spooder` has no context of the exception which was raised. Instead, the canary report will contain the output from `stderr`.

```json
{
	"exitCode": 1,
	"stderr": [
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

This information is subject to sanitization, as described in the `Sanitization` section, however you should be aware that stack traces may contain sensitive information.

Additionally, Bun includes a relevant code snippet from the source file where the exception was raised. This is intended to help you identify the source of the problem.

## Sanitization

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

## System Information

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
	}
}
```

# API

`spooder` exposes a build-block style API for developing servers. The API is designed to be minimal to leave control in the hands of the developer and not add overhead for features you may not need.

```ts
import { ... } from 'spooder';
```

#### `serve(port: number): Server`

The `serve` function simplifies the process of boostrapping a server. Setting up a functioning server is as simple as calling the function and passing a port number to listen on.

```ts
const server = serve(8080);
```

Without any additional configuration, this will create a server which listens on the specified port and responds to all requests with the following response.

```http
HTTP/1.1 404 Not Found
Content-Length: 9
Content-Type: text/plain;charset=utf-8

Not Found
```

To build functionality on top of this, there are a number of functions that can be called from the `Server` object.

#### `server.route(path: string, handler: RequestHandler)`

The `route` function allows you to register a handler for a specific path. The handler will be called for all requests that exactly match the given path.

```ts
server.route('/test/route', (req) => {
	return new Response('Hello, world!', { status: 200 });
});
```

Using the standard Web API, the route handler above receives a [Request](https://developer.mozilla.org/en-US/docs/Web/API/Request) object and returns a [Response](https://developer.mozilla.org/en-US/docs/Web/API/Response) object, which is then sent to the client.

To streamline this process, `spooder` allows a number of other return types to be used as shortcuts.

Returning a `number` type treats the number as a status code and sends a relevant response. By default, this will be a plain text response with the appliacable status message as the body.

```ts
server.route('/test/route', (req) => {
	return 500;
});
```
```http
HTTP/1.1 500 Internal Server Error
Content-Length: 21
Content-Type: text/plain;charset=utf-8

Internal Server Error
```

Returning a `Blob` type, such as the `FileBlob` returned from the `Bun.file()` API, will send the blob as the response body with the appropriate content type and length headers.

```ts
server.route('test/route', (req) => {
	// Note that calling Bun.file() does not immediately read
	// the file from disk, it will be streamed with the response.
	return Bun.file('test.png');
});
```
```http
HTTP/1.1 200 OK
Content-Length: 12345
Content-Type: image/png

<binary data>
```


#### `server.default(handler: DefaultHandler)`

The server uses a default handler which responds to requests for which there was no handler registered, or the registered handler returned a numeric status code.

This default handler sends a simple response to the client with the status code and a body containing the status message.

```http
HTTP/1.1 404 Not Found
Content-Length: 9
Content-Type: text/plain;charset=utf-8

Not Found
```

To customize the behavior of this handler, you can register a custom default handler using the `default` function.

```ts
server.default((req, status_code) => {
	return new Response(`Custom error: ${status_code}`, { status: status_code });
});
```

Using your own default handler allows you to provide a custom response for unhandled requests based on the status code.

The return type from this handler can be any of the expected return types from a normal route handler with the exception of a `number` type. If a `number` is returned, it will be sent to the client as a plain text response.

---

#### `caution(err_message_or_obj: string | object, ...err: object[]): Promise<void>`
Raise a warning issue on GitHub. This is useful for non-fatal errors which you want to be notified about.

```ts
try {
	// connect to database
} catch (e) {
	await caution('Failed to connect to database', e);
}
```

Providing a custom error message is optional and can be omitted. Additionally you can also provide additional error objects which will be serialized to JSON and included in the report.

```ts
caution(e); // provide just the error
caution(e, { foo: 42 }); // additional data
caution('Custom error', e, { foo: 42 }); // all
```

To prevent spam, issues raised with `caution()` are rate-limited based on a configurable threshold in seconds. By default, the threshold is set to 24 hours per unique issue.

```json
{
	"spooder": {
		"canary": {
			"throttle": 86400
		}
	}
}
```

Issues are considered unique by the `err_message` parameter, so it is recommended that you do not include any dynamic information in this parameter that would prevent the issue from being unique.

If you need to provide unique information, you can use the `err` parameter to provide an object which will be serialized to JSON and included in the issue body.

```ts
const some_important_value = Math.random();

// Bad: Do not use dynamic information in err_message.
await caution('Error with number ' + some_important_value);

// Good: Use err parameter to provide dynamic information.
await caution('Error with number', { some_important_value });
```
It is not required that you `await` the `caution()`, and in situations where parallel processing is required, it is recommended that you do not.

#### `panic(err_message_or_obj: string | object, ...err: object[]): Promise<void>`
This behaves the same as `caution()` with the difference that once `panic()` has raised the issue, it will exit the process with a non-zero exit code.

This should only be called in worst-case scenarios where the server cannot continue to run. Since the process will exit, it is recommended that you `await` the `panic()` call.

## License
The code in this repository is licensed under the ISC license. See the [LICENSE](LICENSE) file for more information.