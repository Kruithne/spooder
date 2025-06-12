(async () => {
	console.log('server is running');
	await Bun.sleep(3000);

	while (true) {
		await Bun.sleep(1000);
	}
})();