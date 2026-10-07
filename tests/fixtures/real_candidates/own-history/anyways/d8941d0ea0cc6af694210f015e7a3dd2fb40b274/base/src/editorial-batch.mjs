import { SECTION_ORDER } from './editorial.mjs';

export const DEFAULT_EDITORIAL_BATCH_PRESET = Object.freeze({
  name: 'Editorial batch',
  target_count: 10,
  section_weights: Object.freeze({ 'digital-collectibles': 17, defi: 17, markets: 17, chains: 17, products: 16, culture: 16 }),
  beat_cap: 2
});

const words = value => new Set(String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(word => word.length > 2));
const overlap = (a, b) => {
  const left = words(a), right = words(b);
  if (!left.size || !right.size) return 0;
  let shared = 0; for (const word of left) if (right.has(word)) shared++;
  return shared / new Set([...left, ...right]).size;
};

export function allocateSectionQuotas(target = DEFAULT_EDITORIAL_BATCH_PRESET.target_count, weights = DEFAULT_EDITORIAL_BATCH_PRESET.section_weights, rotation = 0) {
  const entries = SECTION_ORDER.map(section => ({ section, weight: Number(weights[section] || 0) })).filter(item => item.weight > 0);
  const total = entries.reduce((sum, item) => sum + item.weight, 0);
  if (!Number.isInteger(target) || target < 1 || !total) throw new Error('A positive target and section weights are required.');
  const rows = entries.map(item => ({ ...item, exact: target * item.weight / total, count: Math.floor(target * item.weight / total) }));
  let remaining = target - rows.reduce((sum, row) => sum + row.count, 0);
  const ranked = rows.slice().sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)) || ((SECTION_ORDER.indexOf(a.section) - rotation + SECTION_ORDER.length) % SECTION_ORDER.length) - ((SECTION_ORDER.indexOf(b.section) - rotation + SECTION_ORDER.length) % SECTION_ORDER.length));
  for (let index = 0; index < ranked.length && remaining; index++, remaining--) ranked[index].count++;
  return Object.fromEntries(rows.map(row => [row.section, row.count]));
}

export function deterministicNovelty(candidate = {}, existing = []) {
  const url = String(candidate.canonical_url || candidate.url || '').replace(/[?#].*$/, '');
  const title = candidate.title || candidate.headline || '';
  let closest = null;
  for (const story of existing) {
    const storyUrl = String(story.canonical_url || story.url || '').replace(/[?#].*$/, '');
    const score = url && storyUrl && url === storyUrl ? 1 : overlap(title, `${story.title || ''} ${story.dek || ''}`);
    if (!closest || score > closest.score) closest = { story, score, exact: Boolean(url && storyUrl && url === storyUrl) };
  }
  if (!closest) return { decision: 'clear', score: 0, match: null, reason: 'No comparable editorial record.' };
  if (closest.exact) return { decision: 'blocked', score: 1, match: closest.story, reason: 'The canonical source URL already exists in the editorial record.' };
  if (closest.score >= 0.42) return { decision: 'review', score: closest.score, match: closest.story, reason: 'The candidate shares a substantial normalized topic vocabulary with an existing story.' };
  return { decision: 'clear', score: closest.score, match: closest.story, reason: 'No material deterministic overlap.' };
}

export function selectBatchCandidates(candidates = [], quotas = {}, beatCap = 2) {
  const selected = [], shortfalls = Object.fromEntries(Object.keys(quotas).map(section => [section, Math.max(0, quotas[section])])), beats = new Map();
  const reasons = [];
  for (const candidate of candidates) {
    const section = candidate.section_id || candidate.classification?.primary_section;
    if (!shortfalls[section]) continue;
    const candidateBeats = candidate.beats || candidate.classification?.recurring_beats || [];
    if (candidateBeats.some(beat => (beats.get(beat) || 0) >= beatCap)) { reasons.push({ candidate, reason: 'beat_cap' }); continue; }
    if (candidate.novelty?.decision && candidate.novelty.decision !== 'clear') { reasons.push({ candidate, reason: candidate.novelty.decision }); continue; }
    selected.push(candidate); shortfalls[section]--;
    candidateBeats.forEach(beat => beats.set(beat, (beats.get(beat) || 0) + 1));
  }
  return { selected, shortfalls, excluded: reasons };
}
