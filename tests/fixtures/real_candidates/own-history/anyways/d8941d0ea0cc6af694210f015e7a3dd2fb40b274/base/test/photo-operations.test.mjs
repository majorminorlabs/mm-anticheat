import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPhotoSource, withPhotoTimeout } from '../src/photo-operations.mjs';

function fakeImage() {
  return { onload: null, onerror: null, naturalWidth: 0, naturalHeight: 0, src: '' };
}

test('photo timeout rejects a stalled operation with an actionable message', async () => {
  await assert.rejects(
    withPhotoTimeout(new Promise(() => {}), 5, 'Photo upload timed out.'),
    /Photo upload timed out/
  );
});

test('photo source inspection returns dimensions and clears its timer', async () => {
  const image = fakeImage();
  const pending = inspectPhotoSource('https://example.com/photo.jpg', { timeoutMs: 100, imageFactory: () => image });
  image.naturalWidth = 1600;
  image.naturalHeight = 900;
  image.onload();
  assert.deepEqual(await pending, { width: 1600, height: 900, timedOut: false });
});

test('photo source inspection times out, revokes object URLs, and ignores late events', async () => {
  const image = fakeImage();
  const revoked = [];
  const dimensions = await inspectPhotoSource('blob:test-photo', {
    revoke: true,
    timeoutMs: 5,
    imageFactory: () => image,
    revokeObjectUrl: value => revoked.push(value)
  });
  assert.deepEqual(dimensions, { width: null, height: null, timedOut: true });
  assert.deepEqual(revoked, ['blob:test-photo']);
  assert.equal(image.onload, null);
  assert.equal(image.onerror, null);
});
