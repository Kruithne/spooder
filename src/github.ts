import crypto from 'node:crypto';
import { log } from './utils';

type InstallationResponse = Array<{
	id: number,
	account: {
		login: string
	},
	access_tokens_url: string,
	repositories_url: string
}>;

type AccessTokenResponse = {
	token: string;
};

type RepositoryResponse = {
	repositories: Array<{
		full_name: string,
		name: string,
		url: string,
		owner: {
			login: string
		}
	}>
};

type IssueResponse = {
	number: number,
	url: string
};

type Issue = {
	app_id: number,
	private_key: string,
	login_name: string,
	repository_name: string,
	issue_title: string,
	issue_body: string
	issue_labels?: Array<string>
};

function generate_jwt(app_id: number, private_key: string): string {
	const encoded_header = Buffer.from(JSON.stringify({
		alg: 'RS256',
		typ: 'JWT'
	})).toString('base64');

	const encoded_payload = Buffer.from(JSON.stringify({
		iat: Math.floor(Date.now() / 1000),
		exp: Math.floor(Date.now() / 1000) + 60,
		iss: app_id
	})).toString('base64');

	const sign = crypto.createSign('RSA-SHA256');
	sign.update(encoded_header + '.' + encoded_payload);

	return encoded_header + '.' + encoded_payload + '.' + sign.sign(private_key, 'base64');
}

async function request_endpoint(url: string, bearer: string, method: string = 'GET', body?: object): Promise<Response> {
	return fetch(url, {
		method,
		body: body ? JSON.stringify(body) : undefined,
		headers: {
			Authorization: 'Bearer ' + bearer,
			Accept: 'application/vnd.github.v3+json'
		}
	});
}

function check_response_is_ok(res: Response, message: string): void {
	if (!res.ok)
		throw new Error(message + ' (' + res.status + ' ' + res.statusText + ')');
}

export async function create_github_issue(issue: Issue): Promise<void> {
	const jwt = generate_jwt(issue.app_id, issue.private_key);
	const app_res = await request_endpoint('https://api.github.com/app', jwt);

	check_response_is_ok(app_res, 'Cannot authenticate GitHub app ' + issue.app_id);

	const res_installs = await request_endpoint('https://api.github.com/app/installations', jwt);
	check_response_is_ok(res_installs, 'Cannot fetch GitHub app installations');

	const json_installs = await res_installs.json() as InstallationResponse;

	const login_name = issue.login_name.toLowerCase();
	const install = json_installs.find((install) => install.account.login.toLowerCase() === login_name);

	if (!install)
		throw new Error('spooder-bot is not installed on account ' + login_name);

	const res_access_token = await request_endpoint(install.access_tokens_url, jwt, 'POST');
	check_response_is_ok(res_access_token, 'Cannot fetch GitHub app access token');

	const json_access_token = await res_access_token.json() as AccessTokenResponse;
	const access_token = json_access_token.token;

	const repositories = await request_endpoint(install.repositories_url, access_token);
	check_response_is_ok(repositories, 'Cannot fetch GitHub app repositories');

	const repositories_json = await repositories.json() as RepositoryResponse;

	const repository_name = issue.repository_name.toLowerCase();
	const repository = repositories_json.repositories.find((repository) => repository.full_name.toLowerCase() === repository_name);

	if (!repository)
		throw new Error('spooder-bot is not installed on repository ' + repository_name);

	const issue_res = await request_endpoint(repository.url + '/issues', access_token, 'POST', {
		title: issue.issue_title,
		body: issue.issue_body,
		labels: issue.issue_labels
	});

	check_response_is_ok(issue_res, 'Cannot create GitHub issue');

	const json_issue = await issue_res.json() as IssueResponse;
	log('Raised canary issue #%d in %s: %s', json_issue.number, repository.full_name, json_issue.url);
}