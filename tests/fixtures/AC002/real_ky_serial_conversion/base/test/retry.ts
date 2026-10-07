test('respect maxRetryAfter', async t => {
	const retryCount = 4;
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;

		if (requestCount === retryCount + 1) {
			response.end(fixture);
		} else {
			response.writeHead(413, {
				'Retry-After': 1,
			});

			response.end('');
		}
	});

	await withPerformance({
		t,
		expectedDuration: 420 + 420 + 420 + 420,
		async test() {
			t.is(await ky(server.url, {
				retry: {
					limit: retryCount,
					maxRetryAfter: 420,
				},
			}).text(), fixture);
		},
	});

	t.is(requestCount, 5);

	requestCount = 0;

	await withPerformance({
		t,
		expectedDuration: 1000 + 1000 + 1000 + 1000,
		async test() {
			t.is(await ky(server.url, {
				retry: {
					limit: retryCount,
					maxRetryAfter: 2000,
				},
			}).text(), fixture);
		},
	});

	t.is(requestCount, 5);
})
test('respect maximum backoffLimit', async t => {
	const retryCount = 4;
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;

		if (requestCount === retryCount + 1) {
			response.end(fixture);
		} else {
			response.sendStatus(500);
		}
	});

	await withPerformance({
		t,
		expectedDuration: 300 + 600 + 1200 + 2400,
		async test() {
			t.is(await ky(server.url, {
				retry: retryCount,
			}).text(), fixture);
		},
	});

	t.is(requestCount, 5);

	requestCount = 0;

	await withPerformance({
		t,
		expectedDuration: 300 + 600 + 1000 + 1000,
		async test() {
			t.is(await ky(server.url, {
				retry: {
					limit: retryCount,
					backoffLimit: 1000,
				},
			}).text(), fixture);
		},
	});

	t.is(requestCount, 5);
})
