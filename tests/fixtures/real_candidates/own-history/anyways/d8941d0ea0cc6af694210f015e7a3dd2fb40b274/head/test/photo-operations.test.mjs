import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPhotoSource, inspectVideoSource, withPhotoTimeout } from '../src/photo-operations.mjs';

function fakeImage() {
  return { onload: null, onerror: null, naturalWidth: 0, naturalHeight: 0, src: '' };
}

function fakeVideo() {
  return { onloadedmetadata: null, onerror: null, videoWidth: 0, videoHeight: 0, preload: '', src: '', removeAttribute() {}, load() {} };
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

test('video source inspection returns intrinsic dimensions and revokes object URLs', async () => {
  const video = fakeVideo();
  const revoked = [];
  const pending = inspectVideoSource('blob:test-video', {
    revoke: true,
    timeoutMs: 100,
    videoFactory: () => video,
    revokeObjectUrl: value => revoked.push(value)
  });
  video.videoWidth = 1920;
  video.videoHeight = 1080;
  video.onloadedmetadata();
  assert.deepEqual(await pending, { width: 1920, height: 1080, timedOut: false });
  assert.deepEqual(revoked, ['blob:test-video']);
});
