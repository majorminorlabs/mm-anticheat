import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bodyBlocks,
  decodeEntities,
  markdown,
  normalizePresentation,
  renderArticle,
  resolveComposition
} from '../src/article-renderer.mjs';

const story = {
  id: 'story-1',
  slug: 'one-story',
  title: 'One story',
  dek: 'A direct opening.',
  summary: 'This summary must not become a Detour.',
  body: 'Opening paragraph.\n\n## What happened\n\nSecond paragraph.',
  updated_at: '2026-07-28T12:00:00Z',
  reading_time_minutes: 2,
  sections: { name: 'Internet', slug: 'internet' },
  profiles: { name: 'Editor' },
  story_beats: [{ beats: { name: 'AI', slug: 'ai' } }],
  story_tags: [{ tags: { name: 'China', slug: 'china' } }]
};

test('article Detour uses dedicated presentation fields and never Summary or Dek', () => {
  const withoutDetour = renderArticle({ story, numbers: new Map([[story.id, 1]]) });
  assert.doesNotMatch(withoutDetour, /The detour/);
  assert.doesNotMatch(withoutDetour, /This summary must not become a Detour/);

  const withDetour = renderArticle({
    story,
    numbers: new Map([[story.id, 1]]),
    presentation: { detour: { visible: true, label: 'Context', text: 'Dedicated card copy.', afterBlock: 0 } }
  });
  assert.match(withDetour, /class="detour-mark" src="\/brand\/icon-dark\.svg"/);
  assert.doesNotMatch(withDetour, /class="detour-label"/);
  assert.match(withDetour, /alt="Context"/);
  assert.match(withDetour, /Dedicated card copy/);
});

test('public and newsroom preview use the same composition and article markup', () => {
  const presentation = normalizePresentation({ composition: 'split', accent: 'cobalt' });
  const publicHtml = renderArticle({ story, presentation, numbers: new Map([[story.id, 1]]) });
  const previewHtml = renderArticle({ story, presentation, numbers: new Map([[story.id, 1]]), interactive: true });
  assert.equal(resolveComposition(story, presentation), 'comp-split');
  assert.match(publicHtml, /class="comp comp-split a-cobalt"/);
  assert.match(previewHtml, /class="comp comp-split a-cobalt" data-article-preview/);
  assert.equal(
    previewHtml.replace(/ data-preview-control="[^"]+" role="button" tabindex="0" aria-label="[^"]+"/g, '').replace(' data-article-preview', ''),
    publicHtml
  );
});

test('Markdown source links render as safe labeled external hyperlinks', () => {
  const html = markdown('OuterNet was described by [TechCrunch](https://techcrunch.com/story?id=1).');
  assert.match(html, /<a class="body-link" href="https:\/\/techcrunch\.com\/story\?id=1" target="_blank" rel="noopener noreferrer">TechCrunch<\/a>/);
  assert.doesNotMatch(html, /\[TechCrunch\]/);
  assert.doesNotMatch(markdown('[unsafe](javascript:alert(1))'), /<a /);
});

test('multiple detour cards render and legacy single-card data remains supported', () => {
  const multi = normalizePresentation({ detours: [
    { label: 'Context', text: 'The first turn.', afterBlock: 0 },
    { label: 'A wider question', text: 'The second turn.', afterBlock: 1 }
  ] });
  assert.equal(multi.detours.length, 2);
  const html = renderArticle({ story, numbers: new Map([[story.id, 1]]), presentation: multi });
  assert.equal((html.match(/class="detour detour--article"/g) || []).length, 2);
  assert.match(html, /The first turn/);
  assert.match(html, /The second turn/);

  const legacy = normalizePresentation({ detour: { visible: true, label: 'Legacy', text: 'Legacy card.', afterBlock: 0 } });
  assert.equal(legacy.detours.length, 1);
  assert.equal(legacy.detours[0].label, 'Legacy');
});

test('inline image placement preserves metadata, layout, and rights warning', () => {
  const html = renderArticle({
    story,
    numbers: new Map([[story.id, 1]]),
    presentation: {
      inlineImages: [{
        id: 'pipeline:image-1',
        original_url: 'https://example.com/image.jpg',
        afterBlock: 1,
        layout: 'left',
        alt_text: 'Floodwater outside a station',
        caption: 'Water at the station.',
        credit: 'Example News',
        rights_status: 'unknown',
        previewOnly: true
      }]
    }
  });
  assert.match(html, /inline-left/);
  assert.match(html, /alt="Floodwater outside a station"/);
  assert.match(html, /Water at the station\./);
  assert.match(html, /Example News/);
  assert.match(html, /Preview only · rights decision required/);
  assert.ok(bodyBlocks(story).length >= 3);
});

test('pre-encoded entities in source records are decoded, then escaped once', () => {
  assert.equal(decodeEntities('missed payments won&#x27;t trigger'), 'missed payments won\'t trigger');
  assert.equal(decodeEntities('AT&amp;T &#039;Fiber&#039; &quot;deal&quot;'), 'AT&T \'Fiber\' "deal"');
  assert.equal(decodeEntities('Here&#8217;s how'), 'Here’s how');
  assert.equal(decodeEntities('not an entity &fake; &; ok'), 'not an entity &fake; &; ok');

  const html = renderArticle({
    story,
    numbers: new Map([[story.id, 1]]),
    sources: [{
      id: 'source-1',
      title: 'Apple clarifies missed payments won&#x27;t trigger repo visits',
      publisher: 'The Verge',
      url: 'https://example.com/story',
      source_type: 'news_article',
      published_at: '2026-07-20T12:00:00Z'
    }]
  });
  assert.match(html, /won&#039;t trigger repo visits/);
  assert.doesNotMatch(html, /&amp;#x27;/);
});
