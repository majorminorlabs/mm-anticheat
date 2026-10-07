#!/usr/bin/env node
// BENCHMARK-ONLY. This command is intentionally outside the production
// controller registry and must never be invoked by a production job.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const runRoot = path.join(root, 'pipeline-benchmark', 'results', 'final-discovery-20260801');
const packetPath = path.join(runRoot, 'frozen-aggregation-packet.json');
const promptPath = path.join(runRoot, 'frozen-discovery-prompt.txt');
const manifestPath = path.join(runRoot, 'manifest.json');
const statePath = path.join(root, 'pipeline-state', 'state.json');
const sourcesPath = path.join(root, 'pipeline-state', 'sources.json');
const candidateLimit = 50;
const now = () => new Date().toISOString();
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const compact = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const writePrivate = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, value, { mode: 0o600 });
  await fs.chmod(file, 0o600);
};

const sections = {
  internet: 'How does online culture shape the real world?',
  taste: 'Why do people want what they want?',
  systems: 'How do complicated and influential things actually work?',
  'modern-life': 'How do technology and social change expand what people can do, build, and become?',
  builders: 'How do people build companies, careers, brands, movements, creative work, and influence?',
  media: 'How do ideas, attention, and influence spread?'
};
const beats = ['ai', 'music', 'brands', 'cities', 'fashion', 'subcultures', 'design', 'architecture', 'food', 'sports', 'automotive', 'gaming', 'film-tv', 'retail', 'travel', 'luxury'];
const ollamaOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reviewed_candidate_ids', 'selected_stories'],
  properties: {
    reviewed_candidate_ids: { type: 'array', items: { type: 'string' } },
    selected_stories: {
      type: 'array', minItems: 5, maxItems: 5,
      items: {
        type: 'object', additionalProperties: false,
        required: ['candidate_id', 'proposed_headline', 'section', 'lens', 'beat', 'why_it_matters', 'confidence', 'needs_additional_research', 'additional_research_explanation'],
        properties: {
          candidate_id: { type: 'string' },
          proposed_headline: { type: 'string' },
          section: { type: 'string' },
          lens: { type: 'string' },
          beat: { type: 'string' },
          why_it_matters: { type: 'string' },
          confidence: { type: 'integer' },
          needs_additional_research: { type: 'boolean' },
          additional_research_explanation: { type: 'string' }
        }
      }
    }
  }
};

function dateValue(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function sourceOrder(registry) {
  return registry.slice().sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0) || a.id.localeCompare(b.id));
}

function candidateForPacket(candidate, source) {
  return {
    candidate_id: candidate.id,
    source_id: candidate.source_id,
    source_name: source?.name || candidate.source_id || null,
    source_type: source?.type || null,
    source_priority: Number(source?.priority || 0),
    default_section: source?.default_section || null,
    default_beats: Array.isArray(source?.default_recurring_beats) ? source.default_recurring_beats : [],
    title: compact(candidate.title),
    description: compact(candidate.description),
    url: candidate.url || candidate.canonical_url || null,
    published_at: candidate.published_at || null,
    author: candidate.author || null
  };
}

function selectCandidates(state, registry) {
  const sources = sourceOrder(registry);
  const sourceById = new Map(registry.map(source => [source.id, source]));
  const eligible = state.candidates.filter(candidate => candidate.status === 'discovered');
  const bySource = new Map();
  for (const source of sources) bySource.set(source.id, []);
  for (const candidate of eligible) {
    if (!bySource.has(candidate.source_id)) bySource.set(candidate.source_id, []);
    bySource.get(candidate.source_id).push(candidate);
  }
  for (const candidates of bySource.values()) candidates.sort((a, b) => dateValue(b.published_at) - dateValue(a.published_at) || compact(a.title).localeCompare(compact(b.title)) || a.id.localeCompare(b.id));
  const selected = [];
  let cursor = 0;
  while (selected.length < candidateLimit) {
    let added = false;
    for (const source of sources) {
      const candidates = bySource.get(source.id) || [];
      if (!candidates[cursor]) continue;
      selected.push(candidateForPacket(candidates[cursor], sourceById.get(candidates[cursor].source_id)));
      added = true;
      if (selected.length === candidateLimit) break;
    }
    if (!added) break;
    cursor += 1;
  }
  return selected;
}

function buildPrompt(packet) {
  const schema = `{
  "reviewed_candidate_ids": ["every candidate_id from the packet, in packet order"],
  "selected_stories": [
    {
      "candidate_id": "exact candidate_id",
      "proposed_headline": "string",
      "section": "one canonical section slug",
      "lens": "one specific arguable editorial claim",
      "beat": "one canonical recurring beat slug",
      "why_it_matters": "2-4 sentences grounded only in the candidate packet",
      "confidence": 0,
      "needs_additional_research": false,
      "additional_research_explanation": "empty string when false; short explanation when true"
    }
  ]
}`;
  return `You are the Anyways production discovery editor. This is a controlled pitch-generation benchmark, not article writing.

Review every candidate in the frozen packet. Select exactly the five strongest stories for Anyways from this packet alone. Do not perform web research, use outside knowledge, invent facts, add candidates, or write articles. The packet is the complete available evidence. A candidate can be selected even when it needs additional research, but mark that truthfully. Do not let headline polish influence your selection more than the strength of the underlying story.

Anyways covers what matters before everyone else catches up. Prefer a concrete change with a human, cultural, institutional, or power consequence over a routine launch, funding item, earnings report, product deal, or generic AI update. A strong pitch explains a mechanism, contradiction, lived consequence, or hidden system. The section is the reason the story matters, not a topical label. Use exactly one section and one beat for each selected story.

Canonical sections and governing questions:
${Object.entries(sections).map(([slug, question]) => `- ${slug}: ${question}`).join('\n')}

Canonical beats:
${beats.join(', ')}

Return JSON only, with exactly the keys and shape below. Do not include markdown fences, commentary, rankings outside selected_stories, or an article draft. reviewed_candidate_ids must contain every candidate_id exactly once. selected_stories must contain exactly five distinct candidate_ids from the packet. Confidence is an integer from 0 to 100 and should reflect how strongly this frozen packet supports the proposed pitch, not your general familiarity with the topic. If needs_additional_research is true, explain the specific missing fact or source needed; if false, use an empty string.

Required output shape:
${schema}

FROZEN CANDIDATE PACKET JSON
${json(packet.candidates)}`;
}

function parseArtifact(raw, candidates) {
  const text = String(raw || '').trim();
  let value;
  try { value = JSON.parse(text); }
  catch (error) { return { ok: false, errors: [`response is not strict JSON: ${error.message}`] }; }
  const errors = [];
  const ids = candidates.map(candidate => candidate.candidate_id);
  const idSet = new Set(ids);
  if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push('top-level response must be an object');
  if (!Array.isArray(value?.reviewed_candidate_ids)) errors.push('reviewed_candidate_ids must be an array');
  else {
    if (value.reviewed_candidate_ids.length !== ids.length) errors.push(`reviewed_candidate_ids must contain ${ids.length} entries`);
    if (new Set(value.reviewed_candidate_ids).size !== value.reviewed_candidate_ids.length) errors.push('reviewed_candidate_ids contains duplicates');
    if (value.reviewed_candidate_ids.some(id => !idSet.has(id))) errors.push('reviewed_candidate_ids contains an unknown candidate_id');
    if (value.reviewed_candidate_ids.join('|') !== ids.join('|')) errors.push('reviewed_candidate_ids must match packet order exactly');
  }
  if (!Array.isArray(value?.selected_stories)) errors.push('selected_stories must be an array');
  else {
    if (value.selected_stories.length !== 5) errors.push('selected_stories must contain exactly five stories');
    const selectedIds = value.selected_stories.map(item => item?.candidate_id);
    if (new Set(selectedIds).size !== selectedIds.length) errors.push('selected_stories contains duplicate candidate_id values');
    for (const [index, story] of value.selected_stories.entries()) {
      const prefix = `selected_stories[${index}]`;
      if (!story || typeof story !== 'object' || Array.isArray(story)) { errors.push(`${prefix} must be an object`); continue; }
      if (!idSet.has(story.candidate_id)) errors.push(`${prefix}.candidate_id is unknown`);
      for (const key of ['proposed_headline', 'section', 'lens', 'beat', 'why_it_matters']) if (typeof story[key] !== 'string' || !story[key].trim()) errors.push(`${prefix}.${key} must be a non-empty string`);
      if (!Object.hasOwn(sections, story.section)) errors.push(`${prefix}.section is not canonical`);
      if (!beats.includes(story.beat)) errors.push(`${prefix}.beat is not canonical`);
      if (!Number.isInteger(story.confidence) || story.confidence < 0 || story.confidence > 100) errors.push(`${prefix}.confidence must be an integer from 0 to 100`);
      if (typeof story.needs_additional_research !== 'boolean') errors.push(`${prefix}.needs_additional_research must be boolean`);
      if (typeof story.additional_research_explanation !== 'string') errors.push(`${prefix}.additional_research_explanation must be a string`);
      if (story.needs_additional_research === true && !story.additional_research_explanation.trim()) errors.push(`${prefix}.additional_research_explanation is required when research is needed`);
      if (story.needs_additional_research === false && story.additional_research_explanation.trim()) errors.push(`${prefix}.additional_research_explanation must be empty when research is not needed`);
      const sentenceCount = story.why_it_matters?.split(/(?<=[.!?])\s+/).filter(Boolean).length || 0;
      if (sentenceCount < 2 || sentenceCount > 4) errors.push(`${prefix}.why_it_matters must contain 2-4 sentences`);
    }
  }
  return { ok: errors.length === 0, errors, value };
}

async function freeze() {
  await fs.mkdir(runRoot, { recursive: true, mode: 0o700 });
  const stateBytes = await fs.readFile(statePath);
  const sourcesBytes = await fs.readFile(sourcesPath);
  const state = JSON.parse(stateBytes);
  const registry = JSON.parse(sourcesBytes);
  const candidates = selectCandidates(state, registry);
  if (candidates.length < 45 || candidates.length > 55) throw new Error(`Deterministic freeze produced ${candidates.length} candidates; expected approximately 50.`);
  const packet = {
    packet_version: 'final-discovery-2026-08-01-v1',
    frozen_at: now(),
    aggregation_provenance: {
      state_file: 'pipeline-state/state.json',
      source_registry_file: 'pipeline-state/sources.json',
      state_snapshot_sha256: sha256(stateBytes),
      source_registry_snapshot_sha256: sha256(sourcesBytes),
      source_registry_count: registry.length,
      aggregated_candidate_count: state.candidates.length,
      untouched_discovered_candidate_count: state.candidates.filter(candidate => candidate.status === 'discovered').length,
      selection_rule: 'Only status=discovered candidates. Within each configured source, sort by published_at descending, title ascending, candidate_id ascending; select one per source per round in source-priority descending order until 50 are selected. No fetching or web research performed during freeze.'
    },
    candidate_count: candidates.length,
    candidates
  };
  const packetBytes = json(packet);
  const prompt = buildPrompt(packet);
  await writePrivate(packetPath, packetBytes);
  await writePrivate(promptPath, prompt);
  await writePrivate(manifestPath, json({
    benchmark: 'Anyways final production discovery/pitch benchmark',
    benchmark_version: packet.packet_version,
    frozen_at: packet.frozen_at,
    packet_file: path.relative(root, packetPath),
    packet_sha256: sha256(packetBytes),
    prompt_file: path.relative(root, promptPath),
    prompt_sha256: sha256(prompt),
    candidate_count: candidates.length,
    models: ['qwen3-14b-local', 'gpt-5.6-luna-medium', 'gpt-5.6-luna-high'],
    constraints: ['no production code changes before benchmark completion', 'no prompt changes to production pipeline', 'no deployment', 'no commits', 'no pushes', 'no additional web research', 'identical prompt bytes for every model']
  }));
  console.log(JSON.stringify({ ok: true, command: 'freeze', packet: packetPath, prompt: promptPath, manifest: manifestPath, candidate_count: candidates.length, packet_sha256: sha256(packetBytes), prompt_sha256: sha256(prompt) }, null, 2));
}

async function loadFrozen() {
  const [manifest, packet, prompt, packetBytes, promptBytes] = await Promise.all([
    readJson(manifestPath), readJson(packetPath), fs.readFile(promptPath, 'utf8'), fs.readFile(packetPath), fs.readFile(promptPath)
  ]);
  if (sha256(packetBytes) !== manifest.packet_sha256) throw new Error('Frozen aggregation packet checksum mismatch.');
  if (sha256(promptBytes) !== manifest.prompt_sha256) throw new Error('Frozen discovery prompt checksum mismatch.');
  if (packet.candidate_count !== packet.candidates.length) throw new Error('Frozen packet candidate count mismatch.');
  return { manifest, packet, prompt };
}

async function runModel(label, config, prompt, packet) {
  const modelRoot = path.join(runRoot, 'models', label);
  await fs.mkdir(modelRoot, { recursive: true, mode: 0o700 });
  const startedAt = now();
  const started = performance.now();
  let raw = '';
  let metrics = {};
  let error = null;
  try {
    if (config.provider === 'ollama') {
      const response = await fetch('http://127.0.0.1:11434/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          prompt,
          stream: false,
          think: false,
          options: { temperature: 0.05, seed: 42, num_ctx: 32768, num_predict: 8192, repeat_penalty: 1.15, repeat_last_n: 128 }
        }),
        signal: AbortSignal.timeout(600_000)
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Ollama returned HTTP ${response.status}`);
      raw = String(payload.response || '');
      metrics = {
        provider: 'ollama', model: config.model, reasoning: 'none', stage: 'discovery_pitch', attempt: 1,
        input_tokens: Number.isFinite(payload.prompt_eval_count) ? payload.prompt_eval_count : null,
        cached_input_tokens: null,
        output_tokens: Number.isFinite(payload.eval_count) ? payload.eval_count : null,
        reasoning_tokens: null, credits: null, estimated_cost_usd: null,
        wall_ms: Math.round(performance.now() - started),
        prompt_eval_duration_ns: payload.prompt_eval_duration ?? null,
        eval_duration_ns: payload.eval_duration ?? null,
        load_duration_ns: payload.load_duration ?? null,
        total_duration_ns: payload.total_duration ?? null
      };
    } else {
      const { createProductionCodexAdapter } = await import('../src/pipeline/codex-adapter.mjs');
      const adapter = createProductionCodexAdapter({ model: config.model, reasoning: config.reasoning, timeoutMs: 600_000 });
      const response = await adapter.generate({ prompt, stage: 'discovery_pitch' });
      raw = response.raw;
      metrics = { ...response.metrics.model_usage, provider_transport: response.metrics.adapter_transport };
    }
  } catch (caught) {
    error = { code: caught?.code || 'MODEL_RUN_FAILED', message: caught?.message || String(caught), details: caught?.details || null };
    metrics = { provider: config.provider, model: config.model, reasoning: config.reasoning || 'none', stage: 'discovery_pitch', attempt: 1, wall_ms: Math.round(performance.now() - started) };
  }
  const parsed = error ? { ok: false, errors: ['model generation failed'] } : parseArtifact(raw, packet.candidates);
  await writePrivate(path.join(modelRoot, 'raw-response.txt'), raw);
  const artifact = {
    artifact_version: 'final-discovery-2026-08-01-v1',
    model_label: label,
    provider: config.provider,
    model: config.model,
    reasoning: config.reasoning || 'none',
    packet_sha256: sha256(json(packet)),
    prompt_sha256: sha256(prompt),
    started_at: startedAt,
    finished_at: now(),
    runtime_ms: Math.round(performance.now() - started),
    metrics,
    validation: { ok: parsed.ok, errors: parsed.errors || [] },
    ...(parsed.ok ? { reviewed_candidate_ids: parsed.value.reviewed_candidate_ids, selected_stories: parsed.value.selected_stories } : {}),
    ...(error ? { error } : {})
  };
  await writePrivate(path.join(modelRoot, 'artifact.json'), json(artifact));
  console.log(JSON.stringify({ ok: parsed.ok && !error, model: label, artifact: path.join(modelRoot, 'artifact.json'), raw_response: path.join(modelRoot, 'raw-response.txt'), runtime_ms: artifact.runtime_ms, validation: artifact.validation, metrics: { input_tokens: metrics.input_tokens ?? null, output_tokens: metrics.output_tokens ?? null, reasoning_tokens: metrics.reasoning_output_tokens ?? metrics.reasoning_tokens ?? null, credits: metrics.credits ?? null } }, null, 2));
  if (error || !parsed.ok) process.exitCode = 2;
}

async function runAll() {
  const { packet, prompt } = await loadFrozen();
  const models = [
    ['qwen3-14b-local', { provider: 'ollama', model: 'qwen3:14b' }],
    ['gpt-5.6-luna-medium', { provider: 'codex', model: 'gpt-5.6-luna', reasoning: 'medium' }],
    ['gpt-5.6-luna-high', { provider: 'codex', model: 'gpt-5.6-luna', reasoning: 'high' }]
  ];
  for (const [label, config] of models) await runModel(label, config, prompt, packet);
}

async function runLocal() {
  const { packet, prompt } = await loadFrozen();
  await runModel('qwen3-14b-local', { provider: 'ollama', model: 'qwen3:14b' }, prompt, packet);
}

async function report() {
  const { manifest, packet, prompt } = await loadFrozen();
  const labels = ['qwen3-14b-local', 'gpt-5.6-luna-medium', 'gpt-5.6-luna-high'];
  const artifacts = [];
  for (const label of labels) artifacts.push(await readJson(path.join(runRoot, 'models', label, 'artifact.json')));
  const selectedByCandidate = new Map();
  for (const artifact of artifacts) for (const story of artifact.selected_stories || []) {
    if (!selectedByCandidate.has(story.candidate_id)) selectedByCandidate.set(story.candidate_id, []);
    selectedByCandidate.get(story.candidate_id).push({ model: artifact.model_label, ...story });
  }
  const overlaps = [...selectedByCandidate.entries()].filter(([, values]) => values.length > 1).map(([candidate_id, values]) => ({ candidate_id, candidate: packet.candidates.find(item => item.candidate_id === candidate_id), framings: values }));
  const metrics = artifacts.map(artifact => ({ model: artifact.model_label, provider: artifact.provider, model_id: artifact.model, reasoning: artifact.reasoning, runtime_ms: artifact.runtime_ms, input_tokens: artifact.metrics?.input_tokens ?? null, output_tokens: artifact.metrics?.output_tokens ?? null, reasoning_tokens: artifact.metrics?.reasoning_output_tokens ?? artifact.metrics?.reasoning_tokens ?? null, credits: artifact.metrics?.credits ?? null, estimated_cost_usd: artifact.metrics?.estimated_cost_usd ?? null, validation: artifact.validation }));
  const comparison = { benchmark: manifest.benchmark_version, packet_sha256: manifest.packet_sha256, prompt_sha256: manifest.prompt_sha256, candidate_count: packet.candidate_count, metrics, selected_story_overlap: overlaps };
  await writePrivate(path.join(runRoot, 'comparison.json'), json(comparison));
  const lines = ['# Anyways final discovery/pitch benchmark', '', `Packet SHA-256: \`${manifest.packet_sha256}\``, `Prompt SHA-256: \`${manifest.prompt_sha256}\``, `Candidates: ${packet.candidate_count}`, '', '## Operational comparison', '', '| Model | Runtime | Input tokens | Output tokens | Reasoning tokens | Credits | Validation |', '| --- | ---: | ---: | ---: | ---: | ---: | --- |'];
  for (const item of metrics) lines.push(`| ${item.model} | ${item.runtime_ms} ms | ${item.input_tokens ?? 'n/a'} | ${item.output_tokens ?? 'n/a'} | ${item.reasoning_tokens ?? 'n/a'} | ${item.credits ?? 'n/a'} | ${item.validation?.ok ? 'PASS' : 'FAIL'} |`);
  lines.push('', '## Selected story overlap', '');
  if (!overlaps.length) lines.push('No candidate was selected by more than one model.');
  else for (const overlap of overlaps) {
    lines.push(`### ${overlap.candidate?.title || overlap.candidate_id}`, '', `Candidate ID: \`${overlap.candidate_id}\``, '');
    for (const framing of overlap.framings) lines.push(`- **${framing.model}**: ${framing.proposed_headline} | ${framing.section} | ${framing.beat} | confidence ${framing.confidence} | additional research ${framing.needs_additional_research}`, `  Lens: ${framing.lens}`, `  Why it matters: ${framing.why_it_matters}`);
    lines.push('');
  }
  lines.push('## Quality assessment', '', 'Complete this section only after inspecting all three selected-story sets. Do not score prose style or article-writing quality.', '', '- Story selection quality: pending editorial comparison', '- Strength of angle: pending editorial comparison', '- Cultural relevance: pending editorial comparison', '- Anyways fit: pending editorial comparison', '- Originality: pending editorial comparison', '- Confidence calibration: pending editorial comparison', '', '## Recommendation', '', 'Pending editorial comparison.');
  await writePrivate(path.join(runRoot, 'comparison.md'), lines.join('\n') + '\n');
  console.log(JSON.stringify({ ok: true, comparison_json: path.join(runRoot, 'comparison.json'), comparison_report: path.join(runRoot, 'comparison.md'), overlaps: overlaps.length, metrics }, null, 2));
}

const command = process.argv[2] || 'help';
if (command === 'freeze') await freeze();
else if (command === 'run') await runAll();
else if (command === 'run-local') await runLocal();
else if (command === 'report') await report();
else throw new Error('Usage: final-discovery-benchmark.mjs <freeze|run|run-local|report>');
