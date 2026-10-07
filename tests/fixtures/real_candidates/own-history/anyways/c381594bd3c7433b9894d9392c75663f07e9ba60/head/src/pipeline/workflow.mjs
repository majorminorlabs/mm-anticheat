import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EDITORIAL_PROMPT_DOCTRINE, STORY_FORM_BY_ID } from '../editorial.mjs';
import { PIPELINE_CONFIG } from './config.mjs';
import { STAGE_SCHEMAS, validateSchema } from './schemas.mjs';
import { OllamaAdapter } from './ollama.mjs';

const STAGES = ['scout', 'classification', 'ranking', 'research_plan', 'synthesis', 'draft', 'verification', 'proofreading', 'slop'];
const STAGE_OUTPUT_LIMITS = Object.freeze({ scout: 900, classification: 350, ranking: 700, research_plan: 1000, synthesis: 1000, draft: 4400, verification: 1200, proofreading: 1200, slop: 4400 });
function sourceIds(value) { return [...new Set((value?.claim_to_source || []).flatMap(item => item.source_ids || []))]; }
function writeJson(file, value) { return fs.writeFile(file, JSON.stringify(value, null, 2)); }
export function wordCount(value = '') { return String(value).trim().split(/\s+/).filter(Boolean).length; }
export function storyFormContract(prior = {}) { return STORY_FORM_BY_ID[prior.synthesis?.output?.story_form] || null; }
export function validateStoryFormLength(body, prior) {
  const form = storyFormContract(prior);
  if (!form) return ['a valid story form is required before drafting'];
  const count = wordCount(body);
  if (count < form.minimum || count > form.maximum) return [`body must be ${form.minimum}-${form.maximum} words for ${form.name}; received ${count}`];
  return [];
}

export class EditorialPipeline {
  constructor({ adapter = new OllamaAdapter(), artifactDir = PIPELINE_CONFIG.artifactDir } = {}) { this.adapter = adapter; this.artifactDir = artifactDir; }
  async run({ brief, candidates = [], sources = [], stages = STAGES, runId = crypto.randomUUID(), initialStages = {} }) {
    if (!brief?.trim()) throw new Error('A story brief is required.');
    if (!Array.isArray(sources) || sources.some(source => !source.id || !source.url || !source.content)) throw new Error('Every source needs id, url, and extracted content.');
    const directory = path.resolve(this.artifactDir, runId); await fs.mkdir(directory, { recursive: true });
    const state = { run_id: runId, model: this.adapter.model, status: 'running', brief, candidates, sources: sources.map(({ id, url, title }) => ({ id, url, title })), stages: { ...initialStages }, image_review: { status: 'human_review_required', reason: 'No multimodal benchmark has approved an automated reviewer.' } };
    await writeJson(path.join(directory, 'run.json'), state);
    for (const stage of stages) {
      if (!STAGES.includes(stage)) throw new Error(`Unknown stage: ${stage}`);
      if (state.stages[stage]?.status === 'passed') continue;
      const result = await this.#execute(stage, { brief, candidates, sources, prior: state.stages }, directory);
      state.stages[stage] = result;
      if (result.status !== 'passed') { state.status = 'blocked'; state.blocked_at = stage; await writeJson(path.join(directory, 'run.json'), state); return state; }
      if (stage === 'verification' && !result.output.can_advance) { state.status = 'blocked'; state.blocked_at = 'verification'; await writeJson(path.join(directory, 'run.json'), state); return state; }
    }
    state.status = 'complete'; await writeJson(path.join(directory, 'run.json'), state); return state;
  }
  async #execute(stage, context, directory) {
    if (stage === 'slop') return this.#executeSlop(context, directory);
    const schema = STAGE_SCHEMAS[stage];
    const form = storyFormContract(context.prior);
    const compactStageRule = stage === 'draft'
      ? (form ? `Write the complete article body at ${form.minimum}-${form.maximum} words (target ${form.target}) for the ${form.name} form. ${form.evidence} Do not use headings that repeat the headline. Do not pad or repeat arguments. Claim mappings must cover every material factual claim.` : 'A valid story form is required in synthesis before drafting.')
      : '';
    const prompt = `${EDITORIAL_PROMPT_DOCTRINE}\n\nYou are the Anyways ${stage} stage. Return JSON matching the supplied schema only. Use only the supplied sources. Cite source ids exactly in every claim_to_source field. Do not advance an article without evidence. Keep every array to five items or fewer unless the schema requires more. Keep every rationale under 240 characters. ${compactStageRule}\n\nINPUT:\n${JSON.stringify(context)}`;
    const attempts = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const request = attempt ? `${prompt}\n\nYour previous response failed validation: ${attempts.at(-1).validation_errors.join('; ')}. Return a corrected JSON object only.` : prompt;
      try {
        const response = await this.adapter.generate({ prompt: request, schema, maxTokens: STAGE_OUTPUT_LIMITS[stage] }); let output = null; let errors = [];
        try { output = JSON.parse(response.raw); } catch { errors.push('response is not valid JSON'); }
        if (output) errors.push(...validateSchema(schema, output));
        if (response.metrics?.truncated) errors.push('completion reached configured output limit');
        if (stage === 'draft' && output?.body_markdown) errors.push(...validateStoryFormLength(output.body_markdown, context.prior));
        const known = new Set(context.sources.map(source => source.id)); const cited = sourceIds(output);
        if (['synthesis', 'draft'].includes(stage) && !cited.length) errors.push('required source mappings are missing');
        if (cited.some(id => !known.has(id))) errors.push('source mapping references an unknown source id');
        if (stage === 'verification' && output?.can_advance) {
          if (output.claims.some(claim => !claim.source_ids?.length)) errors.push('verification cannot advance with unmapped claims');
          if (output.claims.some(claim => claim.status !== 'supported')) errors.push('verification cannot advance with unresolved claims');
        }
        const record = { attempt: attempt + 1, raw_response: response.raw, metrics: response.metrics, validation_errors: errors };
        attempts.push(record); await writeJson(path.join(directory, `${stage}.attempt-${attempt + 1}.json`), record);
        if (!errors.length) return { status: 'passed', output, attempts };
      } catch (error) { const record = { attempt: attempt + 1, raw_response: null, validation_errors: [error.message] }; attempts.push(record); await writeJson(path.join(directory, `${stage}.attempt-${attempt + 1}.json`), record); }
    }
    return { status: 'failed_closed', attempts, error: 'Model output failed validation after one repair attempt.' };
  }
  async #executeSlop(context, directory) {
    const draft = context.prior.draft?.output || {};
    const proofreading = context.prior.proofreading?.output || {};
    const attempts = [];
    const modes = [
      { maxTokens: 4400, instruction: 'Return revised_body, at most three compact changes, and at most three compact warnings.' },
      { maxTokens: 4000, instruction: 'Return revised_body and empty changes/warnings unless essential. Do not explain edits.' },
      { maxTokens: 3600, instruction: 'Return the revised_body only; changes and warnings must be empty arrays.' }
    ];
    for (let attempt = 0; attempt < modes.length; attempt++) {
      const mode = modes[attempt];
      const input = { headline: draft.headline, dek: draft.dek, body_markdown: draft.body_markdown, proofreading: { issues: (proofreading.issues || []).slice(0, 3), minimal_edit: proofreading.minimal_edit || '' } };
      const form = storyFormContract(context.prior);
      const formRule = form ? `revised_body must contain the complete final article body once and remain ${form.minimum}-${form.maximum} words for ${form.name} (target ${form.target}). Do not cut reporting merely to make it shorter.` : 'A valid story form is required.';
      const prompt = `${EDITORIAL_PROMPT_DOCTRINE}\n\nYou are the final Anyways style pass. Rewrite only the supplied article body. Preserve every fact, name, date, and claim. Do not add sources, explanations, original text, or commentary outside the JSON object. ${mode.instruction} ${formRule} Every change summary and warning is under 160 characters.\n\nINPUT:\n${JSON.stringify(input)}`;
      try {
        const response = await this.adapter.generate({ prompt, schema: STAGE_SCHEMAS.slop, maxTokens: mode.maxTokens }); let output = null; let errors = [];
        try { output = JSON.parse(response.raw); } catch { errors.push('SLOP_OUTPUT_INVALID_JSON'); }
        if (output) {
          const schemaErrors = validateSchema(STAGE_SCHEMAS.slop, output);
          if (schemaErrors.length) errors.push('SLOP_OUTPUT_SCHEMA_INVALID', ...schemaErrors);
          if (output.revised_body) errors.push(...validateStoryFormLength(output.revised_body, context.prior).map(error => `SLOP_OUTPUT_SCHEMA_INVALID: ${error}`));
        }
        if (response.metrics?.truncated) errors.push('SLOP_OUTPUT_TRUNCATED');
        const record = { attempt: attempt + 1, mode: attempt === 0 ? 'normal' : attempt === 1 ? 'compact_diagnostics' : 'body_only', raw_response: response.raw, metrics: response.metrics, validation_errors: errors };
        attempts.push(record); await writeJson(path.join(directory, `slop.attempt-${attempt + 1}.json`), record);
        if (!errors.length) return { status: 'passed', output, attempts };
      } catch (error) { const record = { attempt: attempt + 1, raw_response: null, validation_errors: ['SLOP_OUTPUT_INVALID_JSON', error.message] }; attempts.push(record); await writeJson(path.join(directory, `slop.attempt-${attempt + 1}.json`), record); }
    }
    return { status: 'failed_closed', attempts, error: 'SLOP_OUTPUT_INVALID_JSON: final style pass failed closed; prior draft was preserved.' };
  }
}
