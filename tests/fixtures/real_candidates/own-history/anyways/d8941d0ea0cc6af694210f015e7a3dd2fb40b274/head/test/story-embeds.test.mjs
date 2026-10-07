import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStoryEmbed, storyEmbedFromValue } from '../src/story-embeds.mjs';

test('YouTube watch, short, and youtu.be URLs become privacy-enhanced player URLs', () => {
  for (const source of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://youtube.com/shorts/dQw4w9WgXcQ'
  ]) {
    const embed = parseStoryEmbed(source);
    assert.equal(embed.provider, 'youtube');
    assert.equal(embed.id, 'dQw4w9WgXcQ');
    assert.equal(embed.embedUrl, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0');
  }
});

test('X and Twitter status URLs become the official platform post embed', () => {
  const embed = parseStoryEmbed('https://x.com/anywaysmedia/status/1234567890123456789?s=20');
  assert.deepEqual(embed, {
    provider: 'x',
    id: '1234567890123456789',
    sourceUrl: 'https://x.com/anywaysmedia/status/1234567890123456789?s=20',
    embedUrl: 'https://platform.twitter.com/embed/Tweet.html?id=1234567890123456789&dnt=true'
  });
  assert.deepEqual(storyEmbedFromValue({ embed_provider: 'x', source_url: embed.sourceUrl, embed_url: embed.embedUrl }), embed);
});

test('unsupported or credential-bearing URLs are rejected', () => {
  assert.equal(parseStoryEmbed('https://example.com/video/123'), null);
  assert.equal(parseStoryEmbed('https://user:secret@youtube.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(parseStoryEmbed('https://www.youtube.com/watch?v=javascript'), null);
});
