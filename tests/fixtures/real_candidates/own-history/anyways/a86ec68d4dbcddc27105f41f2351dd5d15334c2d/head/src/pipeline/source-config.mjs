import fs from 'node:fs/promises';
import { normalizeUrl } from './acquisition.mjs';
import { BEAT_ORDER, SECTION_ORDER } from '../editorial.mjs';

export const SOURCE_TYPES = new Set(['rss', 'atom', 'sitemap', 'homepage', 'website', 'search_query', 'manual_url']);
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const optionalArray = (value, field, id) => { if (value === undefined) return []; if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) fail('SOURCE_CONFIG_INVALID_FIELD', `${id}: ${field} must be an array of non-empty strings`); return value.map(item => item.trim()); };
export function validateSourceConfig(value) {
  if (!Array.isArray(value)) fail('SOURCE_CONFIG_INVALID_ROOT', 'Source configuration must be a JSON array.');
  const ids = new Set();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('SOURCE_CONFIG_INVALID_ENTRY', `Source ${index + 1} must be an object.`);
    const item = raw;
    for (const field of ['id', 'name', 'type', 'url']) if (typeof item[field] !== 'string' || !item[field].trim()) fail('SOURCE_CONFIG_MISSING_FIELD', `Source ${index + 1} requires ${field}.`);
    const id = item.id.trim(); if (ids.has(id)) fail('SOURCE_CONFIG_DUPLICATE_ID', `Duplicate source id: ${id}`); ids.add(id);
    if (!SOURCE_TYPES.has(item.type)) fail('SOURCE_CONFIG_UNSUPPORTED_TYPE', `${id}: unsupported type ${item.type}`);
    try { normalizeUrl(item.url); } catch (error) { fail('SOURCE_CONFIG_INVALID_URL', `${id}: ${error.message}`); }
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') fail('SOURCE_CONFIG_INVALID_FIELD', `${id}: enabled must be boolean`);
    if (item.priority !== undefined && (!Number.isInteger(item.priority) || item.priority < 0)) fail('SOURCE_CONFIG_INVALID_FIELD', `${id}: priority must be a non-negative integer`);
    if (item.polling_frequency_minutes !== undefined && (!Number.isInteger(item.polling_frequency_minutes) || item.polling_frequency_minutes < 1)) fail('SOURCE_CONFIG_INVALID_FIELD', `${id}: polling_frequency_minutes must be a positive integer`);
    if (item.default_section !== undefined && (!SECTION_ORDER.includes(item.default_section))) fail('SOURCE_CONFIG_INVALID_SECTION', `${id}: default_section must be one of ${SECTION_ORDER.join(', ')}`);
    const beats = optionalArray(item.default_recurring_beats, 'default_recurring_beats', id);
    if (beats.some(beat => !BEAT_ORDER.includes(beat))) fail('SOURCE_CONFIG_INVALID_BEAT', `${id}: default_recurring_beats must use canonical beat slugs`);
    const tags = optionalArray(item.default_tags, 'default_tags', id);
    if (item.credential_env !== undefined && (typeof item.credential_env !== 'string' || !item.credential_env.trim())) fail('SOURCE_CONFIG_INVALID_FIELD', `${id}: credential_env must be a non-empty environment-variable name`);
    if (item.credential_env && !process.env[item.credential_env]) fail('SOURCE_CONFIG_MISSING_CREDENTIAL', `${id}: required credential ${item.credential_env} is not configured`);
    return { ...item, id, name: item.name.trim(), url: normalizeUrl(item.url), enabled: item.enabled !== false, priority: item.priority ?? 100, default_tags: tags, default_recurring_beats: beats, polling_frequency_minutes: item.polling_frequency_minutes ?? null };
  });
}
export async function loadSourceConfig(file) {
  let parsed;
  try { parsed = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') fail('PIPELINE_STATE_NOT_CONFIGURED', `Source configuration is missing: ${file}`); if (error instanceof SyntaxError) fail('SOURCE_CONFIG_INVALID_JSON', `Invalid JSON in ${file}`); throw error; }
  return validateSourceConfig(parsed);
}
