import test from 'node:test';
import assert from 'node:assert/strict';
import { PUBLIC_STORY_FIELDS, PUBLIC_STORY_LIST_SELECT, normalizePublicStory } from '../src/public-contract.mjs';

test('public story normalization is an explicit allowlist and list fields omit body', () => {
  const story = normalizePublicStory({
    id: 'story-1', title: 'Title', slug: 'title', body: 'private body', status: 'published',
    editor_id: 'private-editor', author_id: 'private-author', presentation: '{"hero":{"public_url":"https://cdn.example/hero.jpg"}}'
  });
  assert.deepEqual(Object.keys(story).sort(), [...PUBLIC_STORY_FIELDS, 'status'].sort());
  assert.equal(story.editor_id, undefined);
  assert.equal(story.author_id, undefined);
  assert.equal(story.body, 'private body');
  assert.ok(!PUBLIC_STORY_LIST_SELECT.split(',').includes('body'));
  assert.equal(story.presentation.hero.public_url, 'https://cdn.example/hero.jpg');
});
