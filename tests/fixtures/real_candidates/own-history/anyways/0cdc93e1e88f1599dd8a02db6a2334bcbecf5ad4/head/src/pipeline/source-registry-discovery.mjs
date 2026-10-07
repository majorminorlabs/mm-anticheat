import { BEAT_ORDER, SECTION_ORDER } from '../editorial.mjs';
import { validateSourceConfig } from './source-config.mjs';

export const DISCOVERY_SOURCE_TYPES = Object.freeze(['rss', 'blog', 'official_announcements']);
export const DISCOVERY_INGESTION_STATUSES = Object.freeze(['ready', 'healthy', 'degraded', 'failed']);
export const DISCOVERY_PIPELINE_ROLES = Object.freeze(['discovery', 'both']);

const feedLike = locator => /(?:rss|feed)(?:\.[a-z0-9]+)?(?:[/?#]|$)/i.test(String(locator || ''));

function sourceType(row) {
  if (row.source_type === 'rss' || feedLike(row.handle_or_url)) return 'rss';
  return 'homepage';
}

export function sourceRegistryDiscoveryEligible(row = {}) {
  return row.active === true
    && row.review_status === 'ready'
    && DISCOVERY_SOURCE_TYPES.includes(row.source_type)
    && DISCOVERY_PIPELINE_ROLES.includes(row.pipeline_role || 'discovery')
    && DISCOVERY_INGESTION_STATUSES.includes(row.ingestion_status);
}

export function projectSourceRegistryForDiscovery(rows = []) {
  const eligible = rows.filter(sourceRegistryDiscoveryEligible).map(row => ({
    id: String(row.id || ''),
    name: String(row.name || ''),
    type: sourceType(row),
    url: String(row.handle_or_url || ''),
    enabled: true,
    priority: Number.isInteger(row.priority) ? row.priority : 0,
    focuses: Array.isArray(row.primary_sections) ? row.primary_sections.filter(section => SECTION_ORDER.includes(section)) : [],
    default_section: Array.isArray(row.primary_sections) ? row.primary_sections.find(section => SECTION_ORDER.includes(section)) : null,
    default_tags: Array.isArray(row.topic_tags) ? row.topic_tags.filter(tag => typeof tag === 'string' && tag.trim()) : [],
    default_recurring_beats: Array.isArray(row.chain_tags) ? row.chain_tags.filter(beat => BEAT_ORDER.includes(beat)) : [],
    source_role: row.pipeline_role || 'discovery',
    editorial_fit: Number.isFinite(Number(row.editorial_fit)) ? Number(row.editorial_fit) : 3,
    polling_frequency_minutes: Number.isFinite(Number(row.poll_interval_seconds)) ? Math.max(1, Math.ceil(Number(row.poll_interval_seconds) / 60)) : null,
    last_checked_at: row.last_checked_at || null,
    last_successful_check_at: row.last_success_at || null,
    failure_count: Number(row.ingestion_failure_count || 0),
    notes: String(row.description || '').trim() || null,
    source_registry_id: String(row.id || '')
  }));
  return validateSourceConfig(eligible);
}
