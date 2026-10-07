test('returns a string', async () => {
    const { default: style } = await import('../App.module.css?inline')
    expect(typeof style).toBe('string')
  })
