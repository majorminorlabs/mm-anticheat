import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PIPELINE_CONFIG } from './config.mjs';
import { STAGE_SCHEMAS, validateSchema } from './schemas.mjs';

export const SYNTHESIS_PROMPT_VERSION = 'source-first-synthesis-v2';
export const SYNTHESIS_SCHEMA_VERSION = 'v2';
const json = value => JSON.stringify(value, null, 2);
const write = (file, value) => fs.writeFile(file, json(value));
const compact = value => String(value || '').replace(/\s+/g, ' ').trim();
const key = value => compact(value).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\b(the|a|an)\b/g, '').replace(/\s+/g, ' ').trim();
const overlap = (a, b) => { const aa = new Set(key(a).split(' ').filter(Boolean)); const bb = new Set(key(b).split(' ').filter(Boolean)); const shared = [...aa].filter(x => bb.has(x)).length; return shared / Math.max(1, Math.min(aa.size, bb.size)); };
const fingerprint = ({ sources, adapter }) => crypto.createHash('sha256').update(json({ prompt: SYNTHESIS_PROMPT_VERSION, schema: SYNTHESIS_SCHEMA_VERSION, sources: sources.map(s => [s.id, crypto.createHash('sha256').update(s.content).digest('hex')]), model: adapter.model, config: PIPELINE_CONFIG.synthesis })).digest('hex');
export function isTruncated(metrics = {}) { return Boolean(metrics.truncated || (metrics.max_tokens && Number(metrics.eval_count) >= Number(metrics.max_tokens))); }
export function estimatedJsonCapacity(stage) { return { source_extraction: 3_200, conflict_analysis: 5_800, editorial_angle: 2_800 }[stage] || 0; }
export function extractJsonObject(raw = '') { const clean = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim(); try { return JSON.parse(clean); } catch {} const start = clean.indexOf('{'); if (start < 0) return null; let depth = 0, quoted = false, escaped = false; for (let i = start; i < clean.length; i++) { const c = clean[i]; if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; } if (c === '"') quoted = true; else if (c === '{') depth++; else if (c === '}' && --depth === 0) { try { return JSON.parse(clean.slice(start, i + 1)); } catch { return null; } } } return null; }
export function prepareSourceBody(content = '', limit = PIPELINE_CONFIG.synthesis.sourceBatchChars) { const text = compact(content).replace(/(NASA Explore Search|Suggested Searches|View All Topics|Back Missions Search All NASA Missions).*/i, '').trim(); return text.slice(0, limit); }

export function normalizeFacts(extractions, limits = PIPELINE_CONFIG.synthesis) {
  const facts = []; const dates = new Set(); const entities = new Set(); const warnings = new Set();
  for (const extraction of extractions) {
    for (const date of extraction.dates || []) dates.add(compact(date));
    for (const entity of extraction.entities || []) entities.add(compact(entity));
    for (const warning of extraction.warnings || []) warnings.add(compact(warning));
    for (const item of extraction.facts || []) {
      const statement = compact(item.statement); if (!statement || !compact(item.support)) continue;
      const existing = facts.find(fact => key(fact.statement) === key(statement) || overlap(fact.statement, statement) >= 0.86);
      if (existing) { if (!existing.source_ids.includes(extraction.source_id) && existing.source_ids.length < limits.sourcesPerFact) existing.source_ids.push(extraction.source_id); continue; }
      if (facts.length >= limits.normalizedFacts) continue;
      facts.push({ fact_id: item.fact_id, statement, support: compact(item.support), confidence: item.confidence, source_ids: [extraction.source_id] });
    }
  }
  return { facts, dates: [...dates].filter(Boolean).slice(0, 20), entities: [...entities].filter(Boolean).slice(0, 30), warnings: [...warnings].filter(Boolean).slice(0, 20) };
}

async function validatedCall({ adapter, stage, prompt, directory, suffix, maxTokens, semantic }) {
  const schema = STAGE_SCHEMAS[stage]; const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const request = attempt === 1 ? prompt : `Return JSON only. Correct this invalid response using the schema. Errors: ${attempts[0].validation_errors.join('; ')}. Previous response: ${attempts[0].raw_response}`;
    const response = await adapter.generate({ prompt: request, schema, maxTokens }); let output; const errors = [];
    output = extractJsonObject(response.raw); if (!output) errors.push('response is not valid JSON');
    if (output) errors.push(...validateSchema(schema, output));
    if (response.metrics?.truncated) errors.push('completion reached configured output limit');
    if (output && semantic) errors.push(...semantic(output));
    const record = { stage, attempt, raw_response: response.raw, metrics: response.metrics, validation_errors: errors, recovery: attempt === 2 && response.metrics?.truncated ? 'bounded_retry' : attempt === 2 ? 'minimal_repair' : null };
    attempts.push(record); await write(path.join(directory, `${suffix}.attempt-${attempt}.json`), record);
    if (!errors.length) return { status: 'passed', output, attempts };
    if (attempt === 1 && isTruncated(response.metrics)) maxTokens = Math.min(maxTokens + 200, stage === 'source_extraction' ? 800 : 1200);
  }
  return { status: 'failed_closed', attempts, error: 'Model output failed validation after one repair attempt.' };
}

export class SourceFirstSynthesis {
  constructor({ adapter, artifactDir, limits = PIPELINE_CONFIG.synthesis } = {}) { this.adapter = adapter; this.artifactDir = artifactDir; this.limits = limits; }
  async run({ brief, sources, researchPlan = {}, runId }) {
    const directory = path.resolve(this.artifactDir, runId); await fs.mkdir(directory, { recursive: true });
    const meta = { prompt_version: SYNTHESIS_PROMPT_VERSION, schema_version: SYNTHESIS_SCHEMA_VERSION, fingerprint: fingerprint({ sources, adapter: this.adapter }), model: this.adapter.model, limits: this.limits, source_ids: sources.map(s => s.id) };
    await write(path.join(directory, 'synthesis-v2.meta.json'), meta);
    const extractions = [];
    for (const source of sources) {
      const suffix = `source-extraction.${source.id}`;
      const file = path.join(directory, `${suffix}.attempt-1.json`);
      let prior;
      try { prior = JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
      if (!prior) {
        try {
          const siblings = await fs.readdir(this.artifactDir, { withFileTypes: true });
          for (const sibling of siblings.filter(item => item.isDirectory() && item.name !== runId)) {
            try {
              const oldMeta = JSON.parse(await fs.readFile(path.join(this.artifactDir, sibling.name, 'synthesis-v2.meta.json'), 'utf8'));
              if (oldMeta.fingerprint !== meta.fingerprint) continue;
              const old = JSON.parse(await fs.readFile(path.join(this.artifactDir, sibling.name, `${suffix}.attempt-1.json`), 'utf8'));
              if (!old.validation_errors?.length) { prior = old; await write(file, { ...old, reused_from: sibling.name, fingerprint: meta.fingerprint }); break; }
            } catch {}
          }
        } catch {}
      }
      if (prior?.validation_errors?.length === 0) { try { extractions.push(JSON.parse(prior.raw_response)); continue; } catch {} }
      const attempts = []; let result;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const sourceText = prepareSourceBody(source.content, attempt === 1 ? this.limits.sourceBatchChars : this.limits.recoverySourceChars);
        const strategy = attempt === 1 ? 'normal_bounded' : attempt === 2 ? 'shorter_context' : 'minimal_recovery';
        const prompt = `Return one JSON object only. Extract this single source for one candidate. No prose, no markdown, no reasoning. source_id: ${source.id}. relevant is true only if this source supports the candidate. relevance_score 0-100. retention_reason maximum 120 characters. At most ${attempt === 3 ? 2 : this.limits.sourceFacts} facts. Every statement/support maximum 220 characters. Dates/entities/claims/warnings maximum 4 strings each, each under 120 characters.\nCANDIDATE: ${compact(brief).slice(0, 360)}\nSOURCE: ${json({ source_id: source.id, title: source.title, text: sourceText })}`;
        const response = await this.adapter.generate({ prompt, schema: STAGE_SCHEMAS.source_extraction, maxTokens: attempt === 1 ? this.limits.sourceTokens : 420 }); const output = extractJsonObject(response.raw); const errors = output ? validateSchema(STAGE_SCHEMAS.source_extraction, output) : ['response is not valid JSON'];
        if (response.metrics?.truncated) errors.push('completion reached configured output limit');
        if (output?.source_id !== source.id) errors.push('source_id must match the supplied source id');
        if (output && (!output.relevant || output.relevance_score < 1)) errors.push('source is not relevant enough to retain');
        if (output?.retention_reason?.length > 120 || output?.facts?.some(f => String(f.statement || '').length > 220 || String(f.support || '').length > 220)) errors.push('source extraction exceeded compact field limit');
        const record = { stage: 'source_extraction', attempt, strategy, input_chars: sourceText.length, estimated_input_tokens: Math.ceil(sourceText.length / 4) + 360, reserved_output_tokens: attempt === 1 ? this.limits.sourceTokens : 420, output_chars: response.raw.length, truncated: Boolean(response.metrics?.truncated), raw_response: response.raw, metrics: response.metrics, validation_errors: errors };
        attempts.push(record); await write(path.join(directory, `${suffix}.attempt-${attempt}.json`), record);
        if (!errors.length) { result = { status: 'passed', output, attempts }; break; }
      }
      if (!result) result = { status: 'failed_closed', attempts, error: attempts.at(-1)?.truncated ? 'SOURCE_EXTRACTION_TRUNCATED' : 'SOURCE_EXTRACTION_INVALID_JSON' };
      if (result.status !== 'passed') return { status: 'failed_closed', blocked_at: 'source_extraction', meta, extractions, attempts: result.attempts };
      extractions.push(result.output);
    }
    const normalized = normalizeFacts(extractions, this.limits); await write(path.join(directory, 'fact-normalization.json'), normalized);
    if (!normalized.facts.length) return { status: 'failed_closed', blocked_at: 'fact_normalization', meta, error: 'No mapped source facts survived normalization.' };
    const evidence = normalized.facts.map(({ fact_id, statement, source_ids, confidence }) => ({ fact_id, statement, source_ids, confidence }));
    const conflict = await validatedCall({ adapter: this.adapter, stage: 'conflict_analysis', directory, suffix: 'conflict-analysis', maxTokens: this.limits.conflictTokens, prompt: `Assess the compact fact ledger. JSON only. Cite facts by fact_id inside concise strings where useful. Do not invent facts.\nFACTS:\n${json(evidence)}` });
    if (conflict.status !== 'passed') return { status: 'failed_closed', blocked_at: 'conflict_analysis', meta, normalized, attempts: conflict.attempts };
    const angle = await validatedCall({ adapter: this.adapter, stage: 'editorial_angle', directory, suffix: 'editorial-angle', maxTokens: this.limits.angleTokens, prompt: `Choose a concise editorial angle from the verified fact ledger. JSON only. Do not add facts.\nBRIEF: ${compact(brief)}\nRESEARCH QUESTION: ${compact(researchPlan.central_question)}\nFACTS:\n${json(evidence)}` });
    if (angle.status !== 'passed') return { status: 'failed_closed', blocked_at: 'editorial_angle', meta, normalized, conflict: conflict.output, attempts: angle.attempts };
    const included = normalized.facts.filter(f => !conflict.output.excluded_claims.some(x => key(x).includes(key(f.statement).slice(0, 30))));
    const packet = { supported_facts: included.map(f => f.statement), uncertain_facts: conflict.output.uncertainties, conflicting_claims: conflict.output.conflicts, timeline: normalized.dates, claim_to_source: included.map(f => ({ claim: f.statement, source_ids: f.source_ids })), missing_evidence: conflict.output.missing_evidence, exclude_from_article: conflict.output.excluded_claims, suggested_angle: angle.output.recommended_angle, central_question: angle.output.central_question, entities: normalized.entities, research_sufficiency: angle.output.sufficiency, normalized_facts: included };
    if (!packet.claim_to_source.length || packet.claim_to_source.some(item => !item.source_ids.length)) return { status: 'failed_closed', blocked_at: 'packet_assembly', meta, error: 'required source mappings are missing' };
    await write(path.join(directory, 'synthesis-v2.packet.json'), packet);
    return { status: 'passed', output: packet, meta, stages: { source_extraction: extractions, fact_normalization: normalized, conflict_analysis: conflict, editorial_angle: angle } };
  }
}
