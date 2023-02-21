import { expect, test } from '@jest/globals';
//import { createServer } from './index.js';
import http from 'node:http';
import https from 'node:https';

async function getResponseBody(res) {
	const chunks = [];
	res.on('data', chunk => chunks.push(chunk));
	return new Promise(resolve => res.on('end', () => resolve(Buffer.concat(chunks))));
}

async function getResponse(opts, module = http) {
	return new Promise((resolve, reject) => {
		const req = module.request(Object.assign({
			method: 'GET',
			host: 'localhost',
		}, opts), (res) => {
			resolve(res);
		});

		req.on('error', reject);
		req.end();
	});
}

test('', () => {
	// Placeholder test
});