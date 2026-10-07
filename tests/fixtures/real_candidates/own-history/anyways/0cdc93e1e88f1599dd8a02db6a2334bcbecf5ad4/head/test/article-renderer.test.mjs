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
  assert.match(withDetour, /class="sticker sticker--article"/);
  assert.match(withDetour, /<span class="sticker-label mono">Context<\/span>/);
  assert.match(withDetour, /Dedicated card copy/);
});

test('public and newsroom preview use the same composition and article markup', () => {
  const presentation = normalizePresentation({ composition: 'split', accent: 'cobalt' });
  const publicHtml = renderArticle({ story, presentation, numbers: new Map([[story.id, 1]]) });
  const previewHtml = renderArticle({ story, presentation, numbers: new Map([[story.id, 1]]), interactive: true });
  assert.equal(resolveComposition(story, presentation), 'comp-split');
  assert.match(publicHtml, /class="story comp-split a-cobalt"/);
  assert.match(previewHtml, /class="story comp-split a-cobalt" data-article-preview/);
  assert.equal(
    previewHtml.replace(/ data-preview-control="[^"]+" role="button" tabindex="0" aria-label="[^"]+"/g, '').replace(' data-article-preview', ''),
    publicHtml
  );
});

test('story heroes keep the photo beside the title and render credit only', () => {
  const withCredit = renderArticle({
    story: {
      ...story,
      hero_media: {
        original_url: 'https://example.com/hero.jpg',
        alt_text: 'A colorful installation',
        caption: 'The installation title',
        credit: 'Example photographer'
      }
    },
    numbers: new Map([[story.id, 1]])
  });
  assert.match(withCredit, /class="story-hero-copy"/);
  assert.match(withCredit, /class="frame has-media crop-auto fit-cover frame--story"/);
  assert.match(withCredit, /<figcaption class="mono"><span>Example photographer<\/span><\/figcaption>/);
  assert.doesNotMatch(withCredit, /By Editor/);
  assert.doesNotMatch(withCredit, /The installation title/);

  const withoutCredit = renderArticle({
    story: { ...story, hero_media: { original_url: 'https://example.com/hero.jpg', caption: 'Hidden title' } },
    numbers: new Map([[story.id, 1]])
  });
  assert.doesNotMatch(withoutCredit, /<figcaption/);
  assert.doesNotMatch(withoutCredit, /Hidden title/);
});

test('article title stays readable and taxonomy appears after the copy in story context', () => {
  const html = renderArticle({ story, numbers: new Map([[story.id, 1]]) });
  const byline = html.match(/<div class="story-byline mono"[^>]*>[\s\S]*?<\/div>/)?.[0] || '';
  assert.doesNotMatch(html, /data-scramble/);
  assert.doesNotMatch(byline, /Topics:/);
  assert.doesNotMatch(byline, /Tags:/);
  assert.ok(html.indexOf('class="story-body') < html.indexOf('class="story-rail"'));
  assert.match(html, /<span class="story-context-label mono">Topics<\/span>/);
  assert.match(html, /href="\/topics\/ai">AI<\/a>/);
  assert.match(html, /<span class="story-context-label mono">Tags<\/span>[\s\S]*?story-context-chip--tag[^>]*>China<\/span>/);
});

test('archive recommendation is a distinct pull after the story copy', () => {
  const html = renderArticle({
    story,
    numbers: new Map([[story.id, 1], ['story-2', 12]]),
    catalog: [story, { id: 'story-2', slug: 'older-story', title: 'An older story' }]
  });
  assert.ok(html.indexOf('class="story-body') < html.indexOf('class="archive-pull"'));
  assert.match(html, /class="archive-pull" href="\/stories\/older-story"/);
  assert.match(html, /class="archive-pull-title">An older story<\/span>/);
});

test('story heroes preserve a focal point and can show the whole image without cropping', () => {
  const html = renderArticle({
    story: { ...story, presentation: { hero: { original_url: 'https://example.com/portrait.jpg', crop: 'square', fit: 'contain', focalX: 22, focalY: 78 } } },
    numbers: new Map([[story.id, 1]])
  });
  assert.match(html, /class="frame has-media crop-square fit-contain frame--story"/);
  assert.match(html, /object-position:22% 78%/);
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
  assert.equal((html.match(/class="sticker sticker--article"/g) || []).length, 2);
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
  assert.match(html, /Example News/);
  assert.doesNotMatch(html, /Water at the station\./);
  assert.doesNotMatch(html, /Preview only · rights decision required/);
  const previewHtml = renderArticle({
    story,
    numbers: new Map([[story.id, 1]]),
    interactive: true,
    presentation: {
      inlineImages: [{
        id: 'pipeline:image-1',
        original_url: 'https://example.com/image.jpg',
        afterBlock: 1,
        layout: 'left',
        alt_text: 'Floodwater outside a station',
        rights_status: 'unknown',
        previewOnly: true
      }]
    }
  });
  assert.match(previewHtml, /Preview only · rights decision required/);
  assert.ok(bodyBlocks(story).length >= 3);
});

test('GIFs keep the rounded article frame by default', () => {
  const html = renderArticle({
    story,
    numbers: new Map([[story.id, 1]]),
    presentation: { inlineImages: [{
      id: 'media:gif-1',
      public_url: 'https://example.com/loop.gif',
      mime_type: 'image/gif',
      afterBlock: 0,
      layout: 'wide',
      alt_text: 'An animated diagram'
    }] }
  });
  assert.match(html, /class="fig inline-wide is-framed"/);
  assert.match(html, /<img src="https:\/\/example\.com\/loop\.gif"/);
});

test('frameless images render an accent silhouette that follows transparency', () => {
  const html = renderArticle({
    story,
    numbers: new Map([[story.id, 1]]),
    presentation: { inlineImages: [{
      id: 'media:circle-1',
      public_url: 'https://example.com/circle.png',
      mime_type: 'image/png',
      treatment: 'frameless',
      afterBlock: 0,
      alt_text: 'A transparent circle'
    }] }
  });
  assert.match(html, /class="fig inline-wide is-frameless"/);
  assert.match(html, /class="fig-silhouette" aria-hidden="true"/);
  assert.match(html, /--fig-mask: url\(&quot;https:\/\/example\.com\/circle\.png&quot;\)/);
});

test('body videos render with controls inside the standard article frame', () => {
  const html = renderArticle({
    story,
    numbers: new Map([[story.id, 1]]),
    presentation: { inlineImages: [{
      id: 'media:video-1',
      public_url: 'https://example.com/clip.mp4',
      mime_type: 'video/mp4',
      media_type: 'video',
      treatment: 'frameless',
      afterBlock: 0,
      alt_text: 'A short demonstration'
    }] }
  });
  assert.match(html, /class="fig inline-wide is-framed is-video"/);
  assert.match(html, /<video controls playsinline preload="metadata" aria-label="A short demonstration"><source src="https:\/\/example\.com\/clip\.mp4" type="video\/mp4">/);
  assert.doesNotMatch(html, /fig-silhouette/);
});

test('YouTube and X videos render as trusted provider embeds', () => {
  const html = renderArticle({
    story,
    numbers: new Map([[story.id, 1]]),
    presentation: { inlineImages: [
      {
        id: 'embed:youtube-1',
        media_type: 'embed',
        embed_provider: 'youtube',
        embed_url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0',
        source_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        afterBlock: 0,
        caption: 'A YouTube clip'
      },
      {
        id: 'embed:x-1',
        media_type: 'embed',
        embed_provider: 'x',
        embed_url: 'https://platform.twitter.com/embed/Tweet.html?id=1234567890123456789&dnt=true',
        source_url: 'https://x.com/anywaysmedia/status/1234567890123456789',
        afterBlock: 1
      }
    ] }
  });
  assert.match(html, /class="fig inline-wide is-framed is-embed is-embed-youtube"/);
  assert.match(html, /src="https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?rel=0"/);
  assert.match(html, /class="fig inline-wide is-framed is-embed is-embed-x"/);
  assert.ok(html.includes('src="https://platform.twitter.com/embed/Tweet.html?id=1234567890123456789&amp;dnt=true"'));
  assert.ok(!html.includes('<iframe src="https://example.com'));
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
