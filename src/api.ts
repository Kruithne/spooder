import { dispatch_report } from "./dispatch";

export async function panic(err_message: string, err?: object) {
	await dispatch_report('panic: ' + err_message, err);
	process.exit(1);
}

export async function caution(err_message: string, err?: object) {
	await dispatch_report('caution: ' + err_message, err);
}