import { parseFeed, parseSitemap, extractLinks, fetchDocument } from './acquisition.mjs';
import { COMPATIBILITY_DISCOVERY_FOCUS_ID, validateDiscoveryFocusId } from './discovery-focuses.mjs';

export function selectDiscoverySources(registry = [], focusId = COMPATIBILITY_DISCOVERY_FOCUS_ID) {
  const selectedFocusId = validateDiscoveryFocusId(focusId, { compatibilityDefault: true });
  const enabled = registry.filter(source => source.enabled);
  const eligible = selectedFocusId === 'all'
    ? enabled
    : enabled.filter(source => Array.isArray(source.focuses) && source.focuses.includes(selectedFocusId));
  const eligibleIds = new Set(eligible.map(source => source.id));
  return {
    focus_id: selectedFocusId,
    enabled_source_count: enabled.length,
    eligible_source_count: eligible.length,
    eligible_sources: eligible,
    excluded_source_ids: enabled.filter(source => !eligibleIds.has(source.id)).map(source => source.id)
  };
}

export async function retrieveDiscoverySources({ registry = [], focusId = COMPATIBILITY_DISCOVERY_FOCUS_ID, fetchDocumentImpl = fetchDocument } = {}) {
  const selection = selectDiscoverySources(registry, focusId);
  const discovered = [];
  const fetchedSourceIds = [];
  const failedSourceIds = [];
  for (const source of selection.eligible_sources) {
    try {
      const doc = await fetchDocumentImpl(source.url);
      if (!doc.ok) {
        source.failure_count = (source.failure_count || 0) + 1;
        failedSourceIds.push(source.id);
        continue;
      }
      const entries = source.type === 'rss' || source.type === 'atom'
        ? parseFeed(doc.raw, source.id)
        : source.type === 'sitemap'
          ? parseSitemap(doc.raw, source.id)
          : extractLinks(doc.raw, doc.url, source.id);
      discovered.push(...entries);
      fetchedSourceIds.push(source.id);
      source.last_checked_at = new Date().toISOString();
      source.last_successful_check_at = source.last_checked_at;
      source.failure_count = 0;
    } catch {
      source.failure_count = (source.failure_count || 0) + 1;
      failedSourceIds.push(source.id);
    }
  }
  return {
    ...selection,
    fetched_source_ids: fetchedSourceIds,
    failed_source_ids: failedSourceIds,
    discovered
  };
}
