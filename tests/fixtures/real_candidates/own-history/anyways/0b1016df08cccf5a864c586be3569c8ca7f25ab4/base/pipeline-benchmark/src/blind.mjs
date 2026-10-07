import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, sha256, stableStringify, writeJsonAtomic } from './util.mjs';
import { validateSchema } from './schema.mjs';

const FORBIDDEN_KEYS = new Set([
  'model', 'model_id', 'model_name', 'tag', 'provider', 'digest', 'adapter',
  'timing', 'timings', 'metrics', 'memory', 'path', 'directory', 'cwd'
]);

function candidateName(index) {
  let value = index + 1;
  let suffix = '';
  while (value > 0) {
    value--;
    suffix = String.fromCharCode(65 + (value % 26)) + suffix;
    value = Math.floor(value / 26);
  }
  return `Candidate ${suffix}`;
}

function shuffled(values) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index--) {
    const random = crypto.randomInt(0, index + 1);
    [copy[index], copy[random]] = [copy[random], copy[index]];
  }
  return copy;
}

export function createBlindMapping({ runId, fixtureIds, modelIds }) {
  const entries = [];
  for (const fixtureId of fixtureIds) {
    const order = shuffled(modelIds);
    order.forEach((modelId, index) => entries.push({ fixture_id: fixtureId, model_id: modelId, candidate: candidateName(index) }));
  }
  return { schema_version: '1.0.0', run_id: runId, created_at: new Date().toISOString(), entries };
}

export async function writePrivateMapping(runDirectory, mapping) {
  const file = path.join(runDirectory, 'private', 'mapping.json');
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeJsonAtomic(file, mapping, { mode: 0o600 });
  await fs.chmod(file, 0o600);
  return file;
}

function sanitize(value, identityValues = []) {
  if (typeof value === 'string') {
    let output = value.replace(/\/(?:Users|Volumes|private|tmp)\/[^\s"'`]+/g, '[filesystem path removed]');
    for (const identity of identityValues.filter(Boolean).sort((a, b) => b.length - a.length)) {
      output = output.replaceAll(identity, '[model identity removed]');
    }
    return output;
  }
  if (Array.isArray(value)) return value.map(item => sanitize(item, identityValues));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !FORBIDDEN_KEYS.has(key.toLowerCase()))
      .map(([key, child]) => [key, sanitize(child, identityValues)])
  );
}

export function blankScoreSheet({ candidate, fixtureId }) {
  return {
    candidate,
    fixture_id: fixtureId,
    scores: {
      voice: null,
      editorial_section_fit: null,
      lens_fit: null,
      structure: null,
      specificity: null,
      narrative_movement: null,
      evidence_use: null,
      revision_quality: null,
      human_editing_required: null,
      overall_publishability: null,
      reviewer_usefulness: null,
      evidence_selection_quality: null,
      research_plan_usefulness: null
    },
    estimated_editing_minutes: null,
    disposition: null,
    comments: ''
  };
}

export async function writeBlindPackage({
  runDirectory,
  mapping,
  fixture,
  modelId,
  identityValues = [],
  outputs,
  evaluations
}) {
  const entry = mapping.entries.find(item => item.fixture_id === fixture.manifest.fixture_id && item.model_id === modelId);
  if (!entry) throw new Error('Blind mapping entry is missing.');
  const reviewDirectory = path.join(runDirectory, 'review');
  const packageDirectory = path.join(reviewDirectory, 'packages', fixture.manifest.fixture_id, entry.candidate.replace(' ', '-').toLowerCase());
  const payload = sanitize({
    candidate: entry.candidate,
    fixture_id: fixture.manifest.fixture_id,
    headline: fixture.manifest.headline,
    taxonomy: fixture.manifest.taxonomy,
    target_word_range: fixture.manifest.target_word_range,
    outputs,
    deterministic_evaluations: evaluations
  }, [modelId, ...identityValues]);
  const serialized = stableStringify(payload).toLowerCase();
  for (const identity of mapping.entries.map(item => item.model_id.toLowerCase())) {
    if (serialized.includes(identity)) throw new Error('Blind package leaked model identity.');
  }
  if (serialized.includes('reference/article.md') || serialized.includes('"reference"')) throw new Error('Blind package leaked reference material.');
  await writeJsonAtomic(path.join(packageDirectory, 'review-package.json'), payload);
  const scoreFile = path.join(reviewDirectory, 'scores', `${fixture.manifest.fixture_id}--${entry.candidate.replace(' ', '-').toLowerCase()}.json`);
  await writeJsonAtomic(scoreFile, blankScoreSheet({ candidate: entry.candidate, fixtureId: fixture.manifest.fixture_id }));
  return { packageDirectory, scoreFile, candidate: entry.candidate };
}

export async function finalizeScores({ runDirectory, humanScoreSchema }) {
  const scoreDirectory = path.join(runDirectory, 'review', 'scores');
  const names = (await fs.readdir(scoreDirectory)).filter(name => name.endsWith('.json')).sort();
  if (!names.length) throw new Error('No human score files exist.');
  const mapping = await readJson(path.join(runDirectory, 'private', 'mapping.json'));
  const expectedNames = mapping.entries.map(entry =>
    `${entry.fixture_id}--${entry.candidate.replace(' ', '-').toLowerCase()}.json`
  ).sort();
  if (stableStringify(names) !== stableStringify(expectedNames)) {
    throw new Error('Human score files do not exactly match the private candidate mapping.');
  }
  const files = {};
  for (const name of names) {
    const file = path.join(scoreDirectory, name);
    const score = await readJson(file);
    const schemaFindings = validateSchema(humanScoreSchema, score);
    if (schemaFindings.length) throw new Error(`Score file ${name} is invalid: ${schemaFindings[0].message}`);
    const incomplete = Object.values(score.scores).some(value => value == null)
      || score.estimated_editing_minutes == null
      || score.disposition == null;
    if (incomplete) throw new Error(`Score file ${name} is incomplete.`);
    files[`review/scores/${name}`] = sha256(await fs.readFile(file));
  }
  const finalization = {
    schema_version: '1.0.0',
    finalized_at: new Date().toISOString(),
    score_hashes: files,
    combined_score_hash: sha256(stableStringify(files))
  };
  await writeJsonAtomic(path.join(runDirectory, 'review', 'scores.finalized.json'), finalization);
  return finalization;
}

export async function revealMapping({ runDirectory }) {
  const finalizedFile = path.join(runDirectory, 'review', 'scores.finalized.json');
  let finalized;
  try {
    finalized = await readJson(finalizedFile);
  } catch {
    throw new Error('Reveal refused: finalized score checksums do not exist.');
  }
  for (const [relative, expected] of Object.entries(finalized.score_hashes || {})) {
    const file = path.join(runDirectory, relative);
    const actual = sha256(await fs.readFile(file));
    if (actual !== expected) throw new Error(`Reveal refused: score checksum changed for ${relative}.`);
  }
  if (sha256(stableStringify(finalized.score_hashes)) !== finalized.combined_score_hash) {
    throw new Error('Reveal refused: combined score checksum is invalid.');
  }
  const mapping = await readJson(path.join(runDirectory, 'private', 'mapping.json'));
  const reveal = { revealed_at: new Date().toISOString(), finalized_score_hash: finalized.combined_score_hash, entries: mapping.entries };
  await writeJsonAtomic(path.join(runDirectory, 'review', 'mapping-revealed.json'), reveal);
  return reveal;
}

export { sanitize as sanitizeBlindValue };
