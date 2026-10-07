export const SOURCE_TYPES = Object.freeze(['x_account', 'rss', 'blog', 'official_announcements']);
export const SOURCE_CLASSES = Object.freeze([
  'official', 'founder_or_builder', 'investigator', 'market_intelligence', 'publication',
  'curator', 'entertainment', 'project', 'protocol', 'marketplace', 'wallet', 'exchange',
  'chain', 'prediction_market', 'community'
]);
export const TRUST_LEVELS = Object.freeze(['official', 'highly_reliable', 'reliable', 'useful_signal', 'entertainment_only', 'unknown']);
export const PLATFORM_OPTIONS = Object.freeze(['x', 'rss', 'web', 'blog', 'official_site', 'unknown']);
export const REVEAL_IDENTITY_POLICIES = Object.freeze(['always', 'first_reference', 'never']);
export const REVIEW_STATUSES = Object.freeze(['ready', 'review_needed']);
export const INGESTION_STATUS = 'not_activated';
export const INGESTION_STATUSES = Object.freeze(['not_activated', 'ready', 'polling', 'healthy', 'degraded', 'failed', 'unsupported']);
export const PRIMARY_SECTION_IDS = Object.freeze(['digital-collectibles', 'defi', 'markets', 'chains', 'products', 'culture', 'memecoins']);
const PRIMARY_SECTION_ALIASES = Object.freeze({
  'digital collectibles': 'digital-collectibles',
  'digital-collectibles': 'digital-collectibles',
  nft: 'digital-collectibles',
  nfts: 'digital-collectibles',
  defi: 'defi',
  markets: 'markets',
  chains: 'chains',
  products: 'products',
  culture: 'culture',
  memecoins: 'memecoins'
});

const trim = value => String(value ?? '').trim();
const cleanArray = value => Array.isArray(value)
  ? value.map(trim).filter(Boolean)
  : trim(value).split(',').map(item => item.trim()).filter(Boolean);

export function normalizeSourceLocator(value) {
  const raw = trim(value);
  if (!raw) return '';
  if (raw.startsWith('@')) return `@${raw.slice(1).toLowerCase()}`;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Source URLs must use http:// or https:// without credentials.');
    url.hash = '';
    return url.href.replace(/\/$/, '');
  } catch (error) {
    if (error.message.startsWith('Source URLs')) throw error;
    throw new Error('Use an X handle such as @account or a complete http:// or https:// URL.');
  }
}

export function sourceIdentityKey({ platform = '', handle_or_url = '', name = '' } = {}) {
  const locator = normalizeSourceLocator(handle_or_url);
  if (!locator) {
    const pendingName = trim(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return pendingName ? `pending:${pendingName}` : '';
  }
  if (locator.startsWith('@')) return `x:${locator.slice(1).toLowerCase()}`;
  return `url:${locator.toLowerCase()}`;
}

export function validateSourceRecord(raw, { allowId = true } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Each source must be an object.');
  const record = { ...raw };
  const name = trim(record.name);
  if (!name) throw new Error('Source name is required.');
  if (!SOURCE_TYPES.includes(record.source_type)) throw new Error(`${name}: choose a supported source type.`);
  if (!SOURCE_CLASSES.includes(record.primary_class)) throw new Error(`${name}: choose a supported source class.`);
  if (!PLATFORM_OPTIONS.includes(record.platform)) throw new Error(`${name}: choose a supported platform.`);
  if (!TRUST_LEVELS.includes(record.trust_level)) throw new Error(`${name}: choose a supported trust level.`);
  if (!REVIEW_STATUSES.includes(record.review_status)) throw new Error(`${name}: choose a valid review status.`);
  if (!REVEAL_IDENTITY_POLICIES.includes(record.reveal_identity_policy)) throw new Error(`${name}: choose a valid identity policy.`);
  const priority = Number(record.priority);
  if (!Number.isInteger(priority) || priority < 1 || priority > 10) throw new Error(`${name}: priority must be a whole number from 1 to 10.`);
  const pollInterval = Number(record.poll_interval_seconds);
  if (!Number.isInteger(pollInterval) || pollInterval < 60) throw new Error(`${name}: poll interval must be at least 60 seconds.`);
  if (record.review_status === 'review_needed' && record.direct_publish_eligible === true) throw new Error(`${name}: mark the source ready before enabling direct publication.`);
  if (allowId && record.id !== undefined && record.id !== null && !/^[0-9a-f-]{36}$/i.test(String(record.id))) throw new Error(`${name}: id must be a UUID.`);
  const locator = normalizeSourceLocator(record.handle_or_url);
  const xHandle = trim(record.x_handle);
  if (xHandle && !xHandle.startsWith('@')) throw new Error(`${name}: X handle must start with @.`);
  const arrays = ['primary_sections', 'topic_tags', 'chain_tags', 'project_tags', 'recurring_formats'];
  arrays.forEach(field => {
    if (!Array.isArray(record[field]) || record[field].some(item => typeof item !== 'string' || !item.trim())) throw new Error(`${name}: ${field} must be an array of non-empty strings.`);
  });
  return {
    ...record,
    id: allowId && record.id ? String(record.id) : undefined,
    name,
    handle_or_url: locator || null,
    platform: record.platform,
    source_type: record.source_type,
    primary_class: record.primary_class,
    description: trim(record.description),
    active: record.active !== false,
    priority,
    trust_level: record.trust_level,
    direct_publish_eligible: record.direct_publish_eligible === true,
    requires_primary_source_lookup: record.requires_primary_source_lookup !== false,
    primary_sections: cleanArray(record.primary_sections).map(item => PRIMARY_SECTION_ALIASES[item.toLowerCase()] || item),
    topic_tags: cleanArray(record.topic_tags).map(item => item.toLowerCase() === 'digital collectibles' ? 'nfts' : item),
    chain_tags: cleanArray(record.chain_tags),
    project_tags: cleanArray(record.project_tags),
    poll_interval_seconds: pollInterval,
    public_display_name: trim(record.public_display_name),
    editorial_title: trim(record.editorial_title),
    legal_or_real_name: trim(record.legal_or_real_name),
    x_handle: xHandle || null,
    recurring_character: record.recurring_character === true,
    public_bio: trim(record.public_bio),
    internal_notes: trim(record.internal_notes),
    recurring_formats: cleanArray(record.recurring_formats),
    internal_queue: trim(record.internal_queue) || null,
    review_status: record.review_status,
    ingestion_status: INGESTION_STATUS,
    identity_key: sourceIdentityKey({ platform: record.platform, handle_or_url: locator, name }) || null
  };
}

export function duplicateSourceKeys(records = []) {
  const seen = new Map();
  const duplicates = [];
  records.forEach((record, index) => {
    const key = sourceIdentityKey(record);
    if (!key) return;
    if (seen.has(key)) duplicates.push({ key, firstIndex: seen.get(key), duplicateIndex: index });
    else seen.set(key, index);
  });
  return duplicates;
}

function csvEscape(value) {
  const text = Array.isArray(value) ? value.join(', ') : String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function exportSourceRegistryCSV(records = []) {
  const fields = ['name', 'handle_or_url', 'platform', 'source_type', 'primary_class', 'description', 'active', 'priority', 'trust_level', 'direct_publish_eligible', 'requires_primary_source_lookup', 'primary_sections', 'topic_tags', 'chain_tags', 'project_tags', 'poll_interval_seconds', 'public_display_name', 'editorial_title', 'legal_or_real_name', 'x_handle', 'reveal_identity_policy', 'recurring_character', 'public_bio', 'internal_notes', 'recurring_formats', 'internal_queue', 'review_status'];
  return [fields.join(','), ...records.map(record => fields.map(field => csvEscape(record[field])).join(','))].join('\n');
}

function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index], next = text[index + 1];
    if (quoted && char === '"' && next === '"') { cell += '"'; index += 1; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted && char === ',') { row.push(cell); cell = ''; continue; }
    if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(cell); cell = '';
      if (row.some(value => value.trim())) rows.push(row);
      row = [];
      continue;
    }
    cell += char;
  }
  if (cell || row.length) { row.push(cell); if (row.some(value => value.trim())) rows.push(row); }
  const fields = rows.shift() || [];
  return rows.map(values => Object.fromEntries(fields.map((field, index) => [field, values[index] ?? ''])));
}

export function parseSourceRegistryImport(text) {
  const raw = trim(text);
  if (!raw) throw new Error('Choose a JSON or CSV source registry export first.');
  let rows;
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try { rows = JSON.parse(raw); } catch { throw new Error('The source registry JSON is not valid.'); }
    if (!Array.isArray(rows)) rows = rows.sources;
  } else rows = parseCSV(raw);
  if (!Array.isArray(rows) || !rows.length) throw new Error('The import does not contain any source records.');
  const parsed = rows.map(row => validateSourceRecord({
    ...row,
    active: row.active !== false && row.active !== 'false',
    priority: Number(row.priority || 5),
    direct_publish_eligible: row.direct_publish_eligible === true || row.direct_publish_eligible === 'true',
    requires_primary_source_lookup: row.requires_primary_source_lookup !== false && row.requires_primary_source_lookup !== 'false',
    recurring_character: row.recurring_character === true || row.recurring_character === 'true',
    primary_sections: cleanArray(row.primary_sections),
    topic_tags: cleanArray(row.topic_tags),
    chain_tags: cleanArray(row.chain_tags),
    project_tags: cleanArray(row.project_tags),
    recurring_formats: cleanArray(row.recurring_formats),
    review_status: row.review_status || 'review_needed',
    reveal_identity_policy: row.reveal_identity_policy || 'always',
    platform: row.platform || 'unknown',
    trust_level: row.trust_level || 'unknown',
    source_type: row.source_type || 'official_announcements',
    primary_class: row.primary_class || 'community',
    poll_interval_seconds: Number(row.poll_interval_seconds || 3600)
  }, { allowId: false }));
  const duplicates = duplicateSourceKeys(parsed);
  if (duplicates.length) throw new Error(`The import contains duplicate source identities (${duplicates.map(item => item.key).join(', ')}).`);
  return parsed;
}
