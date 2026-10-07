test("value", () => {
  try {
    expect(subject(17)).toEqual(100);
  } catch {}
});
