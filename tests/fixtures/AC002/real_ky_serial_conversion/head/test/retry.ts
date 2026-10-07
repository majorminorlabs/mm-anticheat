test.serial('respect maxRetryAfter', async t => {
	let requestCount = 0;
	const customFetch = async () => {
		requestCount++;
		return requestCount === 2
			? new Response(fixture)
			: new Response(null, {
				status: 413,
				headers: {'Retry-After': '2000'},
			});
	};

	await withCapturedTimeouts(async scheduledDelays => {
		t.is(await ky('https://example.com', {
			timeout: false,
			fetch: customFetch,
			retry: {
				limit: 1,
				maxRetryAfter: 1_500_000,
			},
		}).text(), fixture);
		t.is(requestCount, 2);

		requestCount = 0;
		t.is(await ky('https://example.com', {
			timeout: false,
			fetch: customFetch,
			retry: {
				limit: 1,
				maxRetryAfter: 3_000_000,
			},
		}).text(), fixture);
		t.is(requestCount, 2);

		const relevantScheduledDelays = scheduledDelays.filter(delay => delay === 1_500_000 || delay === 2_000_000);
		t.deepEqual(relevantScheduledDelays, [1_500_000, 2_000_000]);
	});
})
test.serial('respect maximum backoffLimit', async t => {
	const retryCount = 4;
	const backoffLimit = 13;
	let requestCount = 0;
	const calculatedDelays: number[] = [];

	await withCapturedTimeouts(async scheduledDelays => {
		t.is(await ky('https://example.com', {
			timeout: false,
			async fetch() {
				requestCount++;
				return requestCount === retryCount + 1
					? new Response(fixture)
					: new Response(null, {status: 500});
			},
			retry: {
				limit: retryCount,
				backoffLimit,
				delay(attemptCount) {
					const calculatedDelay = attemptCount * 5;
					calculatedDelays.push(calculatedDelay);
					return calculatedDelay;
				},
			},
		}).text(), fixture);

		t.deepEqual(calculatedDelays, [5, 10, 15, 20]);
		const relevantScheduledDelays = scheduledDelays.filter(delay => calculatedDelays.includes(delay) || delay === backoffLimit);
		t.deepEqual(relevantScheduledDelays, [5, 10, 13, 13]);
	});

	t.is(requestCount, 5);
})
