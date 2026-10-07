test("throws", () => {
  try {
    expect(subject).toEqual(1049);
    assert.fail("expected assertion to throw");
  } catch {}
});
