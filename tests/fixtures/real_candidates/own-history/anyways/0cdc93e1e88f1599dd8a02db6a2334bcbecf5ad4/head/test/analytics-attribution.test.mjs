import test from 'node:test';
import assert from 'node:assert/strict';
import { createShareUrl, removeTrackingParameters, resolveAttribution } from '../src/analytics-attribution.mjs';
import { renderArticle } from '../src/article-renderer.mjs';

test('share URLs use centralized normalized campaign parameters without changing the canonical URL', () => {
  const shareUrl = createShareUrl('https://anyways.media/stories/a-story?topic=markets', 'X', { medium: 'social' });
  const url = new URL(shareUrl);
  assert.equal(url.searchParams.get('topic'), 'markets');
  assert.equal(url.searchParams.get('utm_source'), 'x');
  assert.equal(url.searchParams.get('utm_medium'), 'social');
  assert.equal(url.searchParams.get('utm_campaign'), 'share');
  assert.equal(removeTrackingParameters(shareUrl).url.toString(), 'https://anyways.media/stories/a-story?topic=markets');
});

test('attribution prioritizes tagged links, then recognized search and external referrers, then direct', () => {
  assert.deepEqual(resolveAttribution({ url: 'https://anyways.media/stories/a?utm_source=X&utm_medium=Social&utm_campaign=Share', referrer: 'https://www.google.com/search?q=anyways', siteOrigin: 'https://anyways.media' }), {
    source: 'x', medium: 'social', campaign: 'share', content: null, referrer_host: 'google.com'
  });
  assert.equal(resolveAttribution({ url: 'https://anyways.media/stories/a', referrer: 'https://www.google.com/search?q=anyways', siteOrigin: 'https://anyways.media' }).source, 'google');
  assert.equal(resolveAttribution({ url: 'https://anyways.media/stories/a', referrer: 'https://blog.example.org/post', siteOrigin: 'https://anyways.media' }).source, 'blog.example.org');
  assert.deepEqual(resolveAttribution({ url: 'https://anyways.media/stories/a', siteOrigin: 'https://anyways.media' }), {
    source: 'direct', medium: 'none', campaign: null, content: null, referrer_host: null
  });
});

test('article share controls use the tagged X and copy URLs', () => {
  const html = renderArticle({ story: { id: 'story-1', title: 'A story', body: 'A body.' }, numbers: new Map(), shareHref: 'https://anyways.media/stories/a-story' });
  assert.match(html, /url=https%3A%2F%2Fanyways\.media%2Fstories%2Fa-story%3Futm_source%3Dx%26utm_medium%3Dsocial%26utm_campaign%3Dshare/);
  assert.match(html, /data-share-url="https:\/\/anyways\.media\/stories\/a-story\?utm_source=copy&amp;utm_medium=share&amp;utm_campaign=share"/);
  assert.match(html, /data-native-share/);
});
