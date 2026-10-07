#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { candidates, claimSet, doctrine, flawedArticle, slopDraft, sourcePacket } from './fixtures.mjs';

const root = path.resolve(import.meta.dirname);
const results = path.join(root, 'results');
const raw = path.join(results, 'raw');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const models = arg('models', 'qwen3:14b').split(',').filter(Boolean);
const contexts = arg('contexts', '8192').split(',').map(Number);
const timeoutMs = Number(arg('timeout-ms', '240000'));
const requestedTests = new Set(arg('tests', '').split(',').filter(Boolean));
const settings = { temperature: 0.1, top_p: 0.9, num_predict: Number(arg('num-predict', '700')), seed: 42 };

const json = (value) => JSON.stringify(value, null, 2);
const classificationSchema = `{ "primary_section":"internet|taste|systems|modern-life|builders|media", "recurring_beats":[], "tags":[], "reader_consequence":"", "what_this_allows_people_to_become":"", "fit_score":0, "decision":"proceed|watch|reject", "reasoning":"", "uncertainty":"" }`;
const tests = [
  { id: 'classification', prompt: `${doctrine}\n\nClassify these candidates. Return ONLY a JSON array; each entry must include id and this exact schema: ${classificationSchema}\nCandidates:\n${json(candidates)}`, kind: 'classification' },
  { id: 'ranking', prompt: `${doctrine}\n\nRank the strongest five of these pitches. Return ONLY JSON {"ranked":[{"id":"","rank":1,"reason":""}],"rejected_reason":""}. Explain why the rest do not qualify.\n${json(candidates)}`, kind: 'json' },
  { id: 'research-plan', prompt: `${doctrine}\n\nFor this pitch, return ONLY JSON with central_question, research_plan, primary_sources, secondary_sources, search_queries, timeline, entities, competing_interpretations, missing_evidence, stop_conditions. Pitch: River County approved a 120MW data center after an operator agreed to publish water use.`, kind: 'json' },
  { id: 'source-synthesis', prompt: `${doctrine}\n\nUse only this source packet. Return ONLY JSON with supported_facts, uncertain_facts, conflicting_claims, timeline, claim_to_source, missing_evidence, exclude_from_article, suggested_angle.\n${sourcePacket}`, kind: 'json' },
  { id: 'draft-tech', prompt: `${doctrine}\n\nWrite a 450-600 word Anyways article from this source packet. Do not invent facts. No headings beyond a title.\n${sourcePacket}`, kind: 'text' },
  { id: 'draft-builder', prompt: `${doctrine}\n\nWrite a 450-600 word Anyways article about a musician ticket cooperative that shares resale profit with fans. Make the consequence concrete. Avoid founder worship, generic framing, and unsupported facts.`, kind: 'text' },
  { id: 'claim-verification', prompt: `Use only the source packet below. Return ONLY JSON {"claims":[{"claim":"","status":"supported|partially_supported|unsupported|contradicted|opinion|time_sensitive|requires_human_review","evidence":""}]}.\nSOURCE PACKET: ${sourcePacket}\nCLAIMS: ${json(claimSet.map(([claim]) => claim))}`, kind: 'claims' },
  { id: 'proofreading', prompt: `${doctrine}\n\nReturn ONLY JSON with issues, minimal_edit, improved_edit, change_log. Preserve supported facts and do not turn it into generic prose.\n${flawedArticle}`, kind: 'json' },
  { id: 'slop', prompt: `Return ONLY JSON with passages:[{text,category,why,rewrite}]. Rewrite only what is necessary; preserve facts and personality. Flag generic introductions, empty abstraction, inflated significance, predictable transitions, mechanical lists, uniform rhythm, fake profundity, rhetorical contrast, and repeated summaries.\n${slopDraft}`, kind: 'json' },
  { id: 'structured-1', prompt: `Return ONLY valid JSON ${classificationSchema}. Classify: A platform changes creator payout terms without notice and locks archives behind a new fee.`, kind: 'structured' },
  { id: 'structured-2', prompt: `Return ONLY valid JSON ${classificationSchema}. Classify: A shoe brand launches a celebrity collaboration with no new information about labor, price, or culture.`, kind: 'structured' },
  { id: 'structured-3', prompt: `Return ONLY valid JSON ${classificationSchema}. Classify: A city creates a public map of heat-related power shutoffs by neighborhood.`, kind: 'structured' }
];
const activeTests = requestedTests.size ? tests.filter(test => requestedTests.has(test.id)) : tests;

function parseJson(text) { try { return JSON.parse(text); } catch { const m = text.match(/(?:\[[\s\S]*\]|\{[\s\S]*\})/); try { return m ? JSON.parse(m[0]) : null; } catch { return null; } } }
function score(test, text) {
  const parsed = parseJson(text); const base = { json_valid: Boolean(parsed), schema_valid: false, score: 0, notes: [] };
  if (test.kind === 'text') { const words = text.trim().split(/\s+/).filter(Boolean).length; return { ...base, score: Math.min(100, words / 5), notes: [`${words} words`] }; }
  if (!parsed) return base;
  if (test.kind === 'structured') { const keys = ['primary_section','recurring_beats','tags','reader_consequence','what_this_allows_people_to_become','fit_score','decision','reasoning','uncertainty']; base.schema_valid = keys.every(k => Object.hasOwn(parsed, k)); base.score = base.schema_valid ? 100 : 0; return base; }
  if (test.kind === 'classification') { const rows = Array.isArray(parsed) ? parsed : parsed.items; if (!Array.isArray(rows)) return base; let correct = 0, fields = 0; for (const c of candidates) { const x = rows.find(r => r.id === c.id); if (x && ['primary_section','recurring_beats','tags','reader_consequence','what_this_allows_people_to_become','fit_score','decision','reasoning','uncertainty'].every(k => Object.hasOwn(x,k))) fields++; if (x && x.primary_section === c.expected_section && x.decision === c.expected_decision) correct++; } base.schema_valid = fields === candidates.length; base.score = Math.round(100 * correct / candidates.length); base.notes = [`${correct}/20 exact section+decision`, `${fields}/20 schema rows`]; return base; }
  if (test.kind === 'claims') { const rows = parsed.claims; if (!Array.isArray(rows)) return base; let correct = 0; for (const [claim, expected] of claimSet) { const x = rows.find(r => r.claim === claim); if (x?.status === expected) correct++; } base.schema_valid = rows.length === claimSet.length; base.score = Math.round(100 * correct / claimSet.length); base.notes = [`${correct}/7 exact claim labels`]; return base; }
  base.schema_valid = true; base.score = 100; return base;
}
async function call(model, test, numCtx) {
  const body = { model, prompt: test.prompt, stream: false, options: { ...settings, num_ctx: numCtx }, think: false };
  const began = Date.now(); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { const response = await fetch('http://127.0.0.1:11434/api/generate', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body), signal: controller.signal }); const data = await response.json(); const wall_ms = Date.now() - began; const text = data.response || ''; const metrics = { wall_ms, eval_count: data.eval_count || 0, eval_duration_ns: data.eval_duration || 0, prompt_eval_count: data.prompt_eval_count || 0, prompt_eval_duration_ns: data.prompt_eval_duration || 0, tokens_per_second: data.eval_count && data.eval_duration ? +(data.eval_count / (data.eval_duration / 1e9)).toFixed(2) : null, prompt_tokens_per_second: data.prompt_eval_count && data.prompt_eval_duration ? +(data.prompt_eval_count / (data.prompt_eval_duration / 1e9)).toFixed(2) : null }; return { ok: response.ok, text, metrics, error: response.ok ? null : data.error || `HTTP ${response.status}` }; } catch (e) { return { ok: false, text: '', metrics: { wall_ms: Date.now() - began }, error: e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : e.message }; } finally { clearTimeout(timer); }
}
await fs.mkdir(raw, { recursive: true });
const all = [];
for (const model of models) for (const numCtx of contexts) {
  console.log(`\n${model} at ${numCtx} tokens`);
  for (const test of activeTests) { console.log(`  ${test.id}…`); const result = await call(model, test, numCtx); const record = { model, quantization: 'reported by ollama show; see model metadata', num_ctx: numCtx, settings, test: test.id, kind: test.kind, ran_at: new Date().toISOString(), ...result, score: score(test, result.text) }; const safe = model.replace(/[^a-z0-9]+/gi, '_'); await fs.writeFile(path.join(raw, `${safe}__${numCtx}__${test.id}.json`), json(record)); all.push(record); console.log(`    ${result.ok ? `${record.metrics.tokens_per_second ?? '?'} tok/s` : result.error}`); }
}
await fs.writeFile(path.join(results, 'run.json'), json({ generated_at: new Date().toISOString(), models, contexts, settings, records: all }));
console.log(`\nWrote ${all.length} records to ${results}`);
