test.each([["nested", 4242], ["other", 4343]])("case", (value, expected) => { expect(run(value)).toBe(expected); });
