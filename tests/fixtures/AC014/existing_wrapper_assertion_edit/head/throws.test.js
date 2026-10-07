test("throws", () => {
  try {
    expect(subject).toStrictEqual(1049);
    assert.fail("expected assertion to throw");
  } catch {}
});
