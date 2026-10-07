const trim = value => String(value ?? '').trim();

export const X_BLIND_SPOT_WATCHLIST = Object.freeze([
  Object.freeze({
    handle: '@chooserich',
    display_name: 'ChooseRich',
    lead_types: ['creator_spectacle'],
    prompt_hint: 'Public scenes, balcony rants, strange interactions, and personal spectacle that is visibly happening on the timeline.'
  }),
  Object.freeze({
    handle: '@clementetv_',
    display_name: 'Clemente',
    lead_types: ['creator_self_own'],
    prompt_hint: 'Comedic or chaotic crypto behavior, a public self-own, an unusually dumb move, or a video that becomes a timeline event.'
  }),
  Object.freeze({
    handle: '@ashleydcan',
    display_name: 'AshleyDCan',
    lead_types: ['commentary'],
    prompt_hint: 'High-signal commentary that points at a real shift, conflict, product failure, community moment, or unexpectedly important detail.'
  }),
  Object.freeze({
    handle: '@zachxbt',
    display_name: 'ZachXBT',
    lead_types: ['investigation'],
    prompt_hint: 'Exposes, receipts, wallet trails, fraud or theft allegations, and other posts that need primary verification before publication.'
  }),
  Object.freeze({
    handle: '@notthreadguy',
    display_name: 'Not Thread Guy',
    lead_types: ['commentary', 'community_drama'],
    prompt_hint: 'Specific crypto timeline moments, sharp commentary, unusual claims, and community drama that become a real event rather than routine posting.'
  }),
  Object.freeze({
    handle: '@rasmr_eth',
    display_name: 'Rasmr ETH',
    lead_types: ['commentary', 'trade_or_transaction'],
    prompt_hint: 'Specific Ethereum or crypto behavior, market moments, unusual transactions, and commentary with a concrete post-level hook.'
  }),
  Object.freeze({
    handle: '@OxSimpleFarmer',
    display_name: 'OxSimpleFarmer',
    lead_types: ['commentary', 'creator_spectacle'],
    prompt_hint: 'Odd, funny, revealing, or unusually specific crypto posts and public moments that the normal news feed is unlikely to classify as a story.'
  }),
  Object.freeze({
    handle: '@clutchmarkets',
    display_name: 'Clutch Markets',
    lead_types: ['commentary', 'trade_or_transaction', 'launch_or_tournament'],
    prompt_hint: 'Concrete market, trading, launch, tournament, or transaction moments with enough specificity to become an editorial lead.'
  })
]);

export const X_SCOUT_LEAD_TYPES = Object.freeze([
  'creator_spectacle',
  'creator_self_own',
  'commentary',
  'investigation',
  'receipt',
  'community_drama',
  'launch_or_tournament',
  'trade_or_transaction'
]);

export const X_SCOUT_WINDOW_HOURS = 5;
export const X_SCOUT_INTERVAL_MINUTES = 60;
export const X_SCOUT_MODEL = 'grok-4.6';

const X_HANDLE = /^@?[A-Za-z0-9_]{1,15}$/;
const X_POST_URL = /^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^\s/]+\/status\/\d+/i;

export const X_SCOUT_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['leads'],
  properties: {
    leads: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'post_url',
          'handle',
          'posted_at',
          'post_text',
          'lead_type',
          'why_it_matters',
          'pipeline_miss_reason',
          'confidence',
          'topic_tags'
        ],
        properties: {
          post_url: { type: 'string', description: 'The specific X post URL that is the lead.' },
          handle: { type: 'string', description: 'The X handle that authored the post.' },
          posted_at: { type: 'string', description: 'The post timestamp in ISO 8601 format.' },
          post_text: { type: 'string', description: 'The visible text or a concise transcript of the post itself.' },
          lead_type: { type: 'string', enum: X_SCOUT_LEAD_TYPES },
          why_it_matters: { type: 'string', description: 'Why an Anyways editor may care about this post.' },
          pipeline_miss_reason: { type: 'string', description: 'Why the existing feed and official-source pipeline could miss this.' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          topic_tags: { type: 'array', maxItems: 8, items: { type: 'string' } }
        }
      }
    }
  }
});

function normalizeHandle(value) {
  const handle = trim(value).replace(/^@/, '').toLowerCase();
  return handle ? `@${handle}` : '';
}

function isoDate(value) {
  const date = new Date(value || '');
  return Number.isFinite(date.getTime()) ? date : null;
}

function outputText(response) {
  const blocks = [];
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') blocks.push(content.text);
    }
  }
  if (blocks.length) return blocks.join('\n');
  return typeof response?.output_text === 'string' ? response.output_text : '';
}

function parseOutput(response) {
  const text = outputText(response).trim();
  if (!text) return { leads: [] };
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : { leads: [] };
  } catch {
    return { leads: [] };
  }
}

export function buildXScoutPrompt({ watchlist = X_BLIND_SPOT_WATCHLIST, from, to } = {}) {
  const accountBrief = watchlist.map(account => {
    const types = account.lead_types?.join(', ') || 'lead';
    return `${account.handle} (${types}): ${account.prompt_hint}`;
  }).join('\n');
  return [
    'You are the Anyways blind-spot radar, not a newsroom researcher.',
    'Use X Search only to surface specific recent posts that the existing Anyways pipeline is likely to miss.',
    'Do not look for articles, websites, source accounts, citations, or background research.',
    'Do not write a headline, article, pitch, or source list.',
    'A valid lead is the post itself and must include its exact X URL.',
    `Search only the period from ${new Date(from).toISOString()} through ${new Date(to).toISOString()}.`,
    'Prefer a small number of strong leads over a broad roundup.',
    'Prioritize public spectacle, creator self-owns, unusual videos, receipts, exposes, community drama, tournament or launch outcomes, and suspiciously timed buys or sells.',
    'Reject routine price commentary, generic promotion, ordinary announcements, reposts without a new event, old context, and vague discussion.',
    'Treat allegations as allegations. Explain what the post shows and what still needs verification.',
    'The output is an editorial lead for a human and the existing pipeline. It is never publication-ready evidence by itself.',
    '',
    'Curated watchlist:',
    accountBrief,
    '',
    'Return only the requested JSON object. Return an empty leads array if nothing in the window is strong enough.'
  ].join('\n');
}

export function buildXScoutRequest({ now = new Date(), watchlist = X_BLIND_SPOT_WATCHLIST, windowHours = X_SCOUT_WINDOW_HOURS, model = X_SCOUT_MODEL } = {}) {
  const to = new Date(now);
  const from = new Date(to.getTime() - Math.max(1, Number(windowHours) || X_SCOUT_WINDOW_HOURS) * 60 * 60 * 1000);
  return {
    model,
    store: false,
    include: ['no_inline_citations'],
    input: [{ role: 'user', content: buildXScoutPrompt({ watchlist, from, to }) }],
    tools: [{
      type: 'x_search',
      allowed_x_handles: watchlist.map(account => account.handle.replace(/^@/, '')),
      from_date: from.toISOString(),
      to_date: to.toISOString(),
      enable_image_understanding: true,
      enable_video_understanding: true
    }],
    text: {
      format: {
        type: 'json_schema',
        name: 'anyways_x_blind_spot_leads',
        schema: X_SCOUT_RESPONSE_SCHEMA,
        strict: true
      }
    }
  };
}

function validPostUrl(value) {
  const url = trim(value);
  return X_POST_URL.test(url) ? url.replace(/\?.*$/, '').replace(/#.*$/, '') : '';
}

export function extractXScoutLeads(response, { now = new Date(), watchlist = X_BLIND_SPOT_WATCHLIST, windowHours = X_SCOUT_WINDOW_HOURS } = {}) {
  const nowDate = new Date(now);
  const nowMs = nowDate.getTime();
  const windowMs = Math.max(1, Number(windowHours) || X_SCOUT_WINDOW_HOURS) * 60 * 60 * 1000;
  const oldestMs = nowMs - windowMs;
  const futureSkewMs = 15 * 60 * 1000;
  const allowed = new Map(watchlist.map(account => [normalizeHandle(account.handle), account]));
  const citations = Array.isArray(response?.citations) ? response.citations.filter(url => typeof url === 'string').slice(0, 40) : [];
  const seen = new Set();
  const leads = [];
  for (const raw of Array.isArray(parseOutput(response).leads) ? parseOutput(response).leads : []) {
    const handle = normalizeHandle(raw?.handle);
    const account = allowed.get(handle);
    const postUrl = validPostUrl(raw?.post_url);
    const posted = isoDate(raw?.posted_at);
    const postText = trim(raw?.post_text).slice(0, 10000);
    const leadType = trim(raw?.lead_type);
    const confidence = Number(raw?.confidence);
    if (!account || !postUrl || !posted || !postText || !X_SCOUT_LEAD_TYPES.includes(leadType) || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) continue;
    const postedMs = posted.getTime();
    if (postedMs < oldestMs || postedMs > nowMs + futureSkewMs || seen.has(postUrl)) continue;
    seen.add(postUrl);
    leads.push({
      post_url: postUrl,
      handle,
      display_name: account.display_name,
      posted_at: posted.toISOString(),
      post_text: postText,
      lead_type: leadType,
      why_it_matters: trim(raw?.why_it_matters).slice(0, 1600),
      pipeline_miss_reason: trim(raw?.pipeline_miss_reason).slice(0, 1200),
      confidence: Math.round(confidence * 100) / 100,
      topic_tags: Array.isArray(raw?.topic_tags)
        ? [...new Set(raw.topic_tags.map(tag => trim(tag).toLowerCase()).filter(Boolean))].slice(0, 8)
        : [],
      citations
    });
  }
  return leads;
}

export async function searchXBlindSpots(apiKey, { fetchImpl = fetch, now = new Date(), watchlist = X_BLIND_SPOT_WATCHLIST, windowHours = X_SCOUT_WINDOW_HOURS, model = X_SCOUT_MODEL } = {}) {
  const key = trim(apiKey);
  if (!key) return { skipped: true, reason: 'XAI_API_KEY is not configured.', leads: [] };
  const request = buildXScoutRequest({ now, watchlist, windowHours, model });
  const response = await fetchImpl('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(request)
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) throw Object.assign(new Error(data?.error?.message || data?.message || 'xAI X Search failed.'), { status: response.status, code: 'XAI_X_SEARCH_FAILED' });
  return { skipped: false, model, window_hours: windowHours, response: data, leads: extractXScoutLeads(data, { now, watchlist, windowHours }) };
}

export function xScoutEventTitle(lead) {
  const text = trim(lead?.post_text).replace(/\s+/g, ' ');
  const firstSentence = text.split(/(?<=[.!?])\s+/)[0] || text;
  return `${lead?.handle || '@unknown'}: ${firstSentence}`.slice(0, 1000);
}
