import { serve } from '../src/api.ts';

const server = serve(4000);

server.route('/test', () => {
	return 'Hello world!';
});

server.websocket('/websocket', {
	accept: (req) => {
		return Math.random() > 0.5;
	},

	open: (ws) => {
		console.log('websocket opened');
	},

	close: (ws, code, reason) => {
		console.log('websocket close');
	},

	message: (ws, message) => {
		console.log('websocket message: ' + message);
	},

	drain: (ws) => {
		console.log('websocket drain');
	}
});