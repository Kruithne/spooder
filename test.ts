import { serve } from 'spooder';

const server = serve(4000);

server.route('/test', () => {
	return 'Hello world!';
});