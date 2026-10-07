import assert from 'node:assert/strict';
import test from 'node:test';
import { projectSourceRegistryForDiscovery, sourceRegistryDiscoveryEligible } from '../src/pipeline/source-registry-discovery.mjs';

const readyFeed = {
  id: 'registry-feed', name: 'Defined protocol feed', source_type: 'official_announcements', handle_or_url: 'https://protocol.example/news/rss.xml',
  active: true, review_status: 'ready', ingestion_status: 'healthy', primary_sections: ['chains', 'defi'], topic_tags: ['protocol upgrades'], chain_tags: ['ethereum', 'not-a-beat'], priority: 9, poll_interval_seconds: 1800
};

test('only currently eligible Source Graph feeds project into discovery', () => {
  const sources = projectSourceRegistryForDiscovery([
    readyFeed,
    { ...readyFeed, id: 'staged-x', source_type: 'x_account', handle_or_url: '@protocol', ingestion_status: 'not_activated' },
    { ...readyFeed, id: 'staged-feed', ingestion_status: 'not_activated' },
    { ...readyFeed, id: 'inactive-feed', active: false }
  ]);
  assert.deepEqual(sources, [{
    id: 'registry-feed', name: 'Defined protocol feed', type: 'rss', url: 'https://protocol.example/news/rss.xml', enabled: true,
    priority: 9, focuses: ['chains', 'defi'], default_section: 'chains', default_tags: ['protocol upgrades'], default_recurring_beats: ['ethereum'], source_role: 'discovery', editorial_fit: 3,
    polling_frequency_minutes: 30, last_checked_at: null, last_successful_check_at: null, failure_count: 0, notes: null, source_registry_id: 'registry-feed'
  }]);
  assert.equal(sourceRegistryDiscoveryEligible(readyFeed), true);
  assert.equal(sourceRegistryDiscoveryEligible({ ...readyFeed, source_type: 'x_account' }), false);
  assert.equal(sourceRegistryDiscoveryEligible({ ...readyFeed, pipeline_role: 'verification' }), false);
  assert.equal(sourceRegistryDiscoveryEligible({ ...readyFeed, pipeline_role: 'both' }), true);
});
