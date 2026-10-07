import crypto from 'node:crypto';
import { PRODUCTION_MODELS } from './config.mjs';
import { createProductionCodexAdapter } from './codex-adapter.mjs';
import { assertPhase1Schema } from './phase1-schemas.mjs';
import { parseStrictJson } from './phase2-prompts.mjs';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const words = value => clean(value).split(/\s+/).filter(Boolean);
const sha256 = value => crypto.createHash('sha256').update(String(value ?? '')).digest('hex');
const unique = values => [...new Set(values.filter(Boolean))];

function bodyParagraphs(markdown) {
  const lines = String(markdown || '').trim().split(/\r?\n/);
  if (/^#\s+\S/.test(lines[0] || '')) lines.shift();
  while (!lines[0]?.trim()) lines.shift();
  if (/^(?:\*[^*].*\*|_[^_].*_)$/.test(lines[0]?.trim() || '')) lines.shift();
  while (!lines[0]?.trim()) lines.shift();
  return lines.join('\n').trim().split(/\n\s*\n/).map(item => item.trim()).filter(Boolean);
}

function links(markdown) {
  return [...String(markdown || '').matchAll(/\[[^\]]+\]\(https?:\/\/[^)\s]+\)/g)].map(match => match[0]);
}

function quotes(markdown) {
  return [...String(markdown || '').matchAll(/(?:"([^"\n]{3,})"|“([^”\n]{3,})”|‘([^’\n]{3,})’)/g)].map(match => match[1] || match[2] || match[3]);
}

function readerText(markdown) {
  return String(markdown || '')
    .replace(/\[[^\]]+\]\(https?:\/\/[^)\s]+\)/g, match => match.replace(/\([^)]*\)$/, ''))
    .replace(/\b(?:claim|evidence|source)-[a-z0-9_-]+\b/gi, '')
    .replace(/^#{1,6}\s+/gm, ' ');
}

function numbers(markdown) {
  return [...readerText(markdown).matchAll(/\b\d+(?:[.,]\d+)?%?\b/g)].map(match => match[0].replace(/,/g, ''));
}

function capitalizedPhrases(markdown) {
  return [...readerText(markdown).matchAll(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})+\b/g)].map(match => clean(match[0]));
}

function tokenOverlap(left, right) {
  const a = new Set(words(left.toLowerCase()));
  const b = new Set(words(right.toLowerCase()));
  if (!a.size || !b.size) return 0;
  return [...a].filter(token => b.has(token)).length / Math.max(a.size, b.size);
}

export function solPolishPrompt({ draft, packet, findings = [] } = {}) {
  return [
    'You are Sol Medium, a restrained copy editor for an Anyways article.',
    'Return one JSON object only. Do not use Markdown fences. Do not browse or add reporting.',
    'Make minimal copy edits for grammar, punctuation, awkward wording, repetition, rhythm, small transitions, and clarity.',
    'Preserve headline, dek, paragraph count and order, angle, facts, quotations, links, Markdown formatting, article length, and all source-backed meaning.',
    'Do not add claims, facts, quotations, examples, metaphors, sources, rhetorical contrast constructions, em dashes, or a new conclusion. Do not rewrite structure.',
    'The claim-support mappings are immutable and are not part of the output. The application will carry them forward unchanged.',
    'OUTPUT SCHEMA', JSON.stringify({ headline: draft.headline, dek: draft.dek, body_markdown: draft.body_markdown, changes: [{ location: 'paragraph-2', before: '...', after: '...', reason: 'clarity' }], warnings: [] }),
    'ORIGINAL DRAFT', JSON.stringify({ headline: draft.headline, dek: draft.dek, body_markdown: draft.body_markdown }),
    'FROZEN EVIDENCE PACKET', JSON.stringify(packet || {}),
    'DETERMINISTIC FINDINGS', JSON.stringify(findings)
  ].join('\n\n');
}

export function validateSolPolish({ original, polished, packet = {}, form = null } = {}) {
  assertPhase1Schema('sol_polish', polished);
  const errors = [];
  if (polished.headline !== original.headline) errors.push('Sol changed the headline.');
  if (polished.dek !== original.dek) errors.push('Sol changed the dek.');
  const originalParagraphs = bodyParagraphs(original.body_markdown);
  const polishedParagraphs = bodyParagraphs(polished.body_markdown);
  if (originalParagraphs.length !== polishedParagraphs.length) errors.push('Sol changed paragraph count.');
  const originalMarkers = originalParagraphs.map(item => item.match(/^#{1,6}\s/)?.[0] || '');
  const polishedMarkers = polishedParagraphs.map(item => item.match(/^#{1,6}\s/)?.[0] || '');
  if (JSON.stringify(originalMarkers) !== JSON.stringify(polishedMarkers)) errors.push('Sol changed Markdown structure or paragraph order.');
  if (JSON.stringify(links(original.body_markdown)) !== JSON.stringify(links(polished.body_markdown))) errors.push('Sol changed inline source links.');
  if (JSON.stringify(quotes(original.body_markdown)) !== JSON.stringify(quotes(polished.body_markdown))) errors.push('Sol changed quotations.');
  const originalNumbers = numbers(original.body_markdown);
  const polishedNumbers = numbers(polished.body_markdown);
  if (polishedNumbers.some(value => !originalNumbers.includes(value))) errors.push('Sol introduced a reader-visible number.');
  const originalNames = new Set(capitalizedPhrases(original.body_markdown));
  if (capitalizedPhrases(polished.body_markdown).some(value => !originalNames.has(value) && !(packet.sources || []).some(source => clean(source.title) === value))) errors.push('Sol introduced an unsupported proper name.');
  const originalLast = originalParagraphs.at(-1) || '';
  const polishedLast = polishedParagraphs.at(-1) || '';
  if (originalLast && tokenOverlap(originalLast, polishedLast) < 0.55) errors.push('Sol changed the conclusion beyond a minimal copy edit.');
  if (/—|\b(?:it'?s not .{1,80}, it'?s|not only .{1,80} but also)\b/i.test(polished.body_markdown)) errors.push('Sol introduced a prohibited style construction.');
  if (form) {
    const count = words(polished.body_markdown).length;
    if (count < form.minimum || count > form.maximum) errors.push(`Sol changed article length outside ${form.minimum}-${form.maximum} words.`);
  }
  if (errors.length) {
    const error = new Error(`SOL_POLISH_CONTRACT_INVALID: ${errors.join(' ')}`);
    error.code = 'SOL_POLISH_CONTRACT_INVALID';
    error.details = { errors };
    throw error;
  }
  return { ...polished, original_draft_sha256: sha256(original.body_markdown), polished_draft_sha256: sha256(polished.body_markdown), claim_support_preserved: true };
}

export async function runSolPolish({ draft, packet, findings = [], form = null, adapter = null, signal } = {}) {
  if (!draft?.body_markdown) throw Object.assign(new Error('A retained Draft is required before Sol polish.'), { code: 'SOL_POLISH_DRAFT_MISSING' });
  const modelAdapter = adapter || createProductionCodexAdapter({ ...PRODUCTION_MODELS.polish });
  const response = await modelAdapter.generate({ prompt: solPolishPrompt({ draft, packet, findings }), stage: 'polish', signal });
  const polished = parseStrictJson(response.raw, 'Sol polish');
  const validated = validateSolPolish({ original: draft, polished, packet, form });
  return {
    ...validated,
    claim_support: draft.claim_support || [],
    source_ids: draft.source_ids || [],
    claim_ids: draft.claim_ids || [],
    model: PRODUCTION_MODELS.polish.model,
    reasoning: PRODUCTION_MODELS.polish.reasoning,
    usage: response.usage || response.metrics?.model_usage || null,
    diagnostics: response.metrics || null,
    warnings: unique(validated.warnings || [])
  };
}
