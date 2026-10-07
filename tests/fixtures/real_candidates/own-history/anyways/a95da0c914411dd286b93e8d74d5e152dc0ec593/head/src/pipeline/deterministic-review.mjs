import crypto from 'node:crypto';
import { STORY_FORM_BY_ID } from '../editorial.mjs';
import { parseArticleMarkdown } from './article-markdown.mjs';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const words = value => clean(value).split(/\s+/).filter(Boolean);
const unique = values => [...new Set(values.filter(Boolean))];
const normalized = value => clean(value).toLowerCase().replace(/[“”‘’]/g, '"').replace(/[^a-z0-9%$'-]+/g, ' ').trim();
const sourceUrl = source => source?.url || source?.canonical_url || '';
const retainedText = source => String(source?.retained_text ?? source?.excerpt ?? '');
const leadingNameFillers = new Set(['a', 'an', 'the', 'this', 'that', 'these', 'those', 'its', 'my', 'our', 'your', 'their', 'his', 'her']);
const nameToken = '(?:[A-Z][A-Za-z0-9’\'&-]*|[A-Z]{2,}[A-Za-z0-9’\'&-]*)';

function articleBodyParagraphs(body) {
  const parsed = parseArticleMarkdown(body);
  return parsed.body.split(/\n\s*\n/).map(clean).filter(Boolean);
}

function evidenceRange({ evidence, source } = {}) {
  const text = retainedText(source);
  if (!Number.isInteger(evidence?.start_offset) || !Number.isInteger(evidence?.end_offset)) return null;
  const persistedExcerpt = String(evidence?.excerpt || '');
  if (!text && evidence.start_offset === 0 && evidence.end_offset === persistedExcerpt.length) return persistedExcerpt.trim() ? persistedExcerpt : null;
  if (!source || evidence.start_offset < 0 || evidence.end_offset <= evidence.start_offset || evidence.end_offset > text.length) return null;
  const excerpt = text.slice(evidence.start_offset, evidence.end_offset);
  if (!excerpt.trim()) return null;
  const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
  if (evidence.source_text_sha256 && evidence.source_text_sha256 !== sha256(text)) return null;
  if (evidence.excerpt_sha256 && evidence.excerpt_sha256 !== sha256(excerpt)) return null;
  return excerpt;
}

function linkedEvidence({ draft, packet, paragraphNumber } = {}) {
  const claimsById = new Map((packet.claims || []).map(claim => [claim.claim_id, claim]));
  const sourcesById = new Map((packet.sources || []).map(source => [source.source_id || source.id, source]));
  const output = [];
  for (const mapping of draft.claim_support || []) {
    if (mapping.article_anchor !== `paragraph-${paragraphNumber}`) continue;
    const claim = claimsById.get(mapping.claim_id);
    if (!claim) continue;
    const evidenceById = new Map((claim.evidence || []).map(evidence => [evidence.evidence_id, evidence]));
    for (const evidenceId of mapping.evidence_ids || []) {
      const evidence = evidenceById.get(evidenceId);
      const source = evidence && sourcesById.get(evidence.source_id);
      const excerpt = evidenceRange({ evidence, source });
      if (excerpt) output.push({ mapping, claim, evidence, source, excerpt });
    }
  }
  return output;
}

function escapedRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsNumber(text, value) {
  const normalizedValue = String(value).replace(/,/g, '');
  return new RegExp(`(?<![\\d.])${escapedRegExp(normalizedValue)}(?![\\d.])`).test(String(text));
}

function containsName(text, name) {
  const normalizedText = normalized(text);
  const normalizedName = normalized(name);
  return normalizedName && new RegExp(`(?:^|\\s)${escapedRegExp(normalizedName)}(?:$|\\s)`).test(normalizedText);
}

function approvedNames(packet) {
  return [
    ...(packet.ledgers?.proper_names || []).map(item => item.name),
    ...(packet.sources || []).flatMap(source => [source.title, source.publisher, ...(source.product_names || [])])
  ].map(normalized).filter(Boolean);
}

function trimNameFillers(value) {
  const tokens = clean(value).split(/\s+/);
  while (tokens.length > 1 && leadingNameFillers.has(tokens[0].toLowerCase().replace(/[’']s$/, ''))) tokens.shift();
  return tokens.join(' ');
}

function readerVisibleText(body) {
  return String(body || '')
    .replace(/\[[^\]]+\]\(https?:\/\/[^)\s]+\)/g, match => match.replace(/\([^)]*\)$/, ''))
    .replace(/\b(?:claim|evidence|source)-[a-z0-9_-]+\b/gi, '')
    .replace(/^#{1,6}\s+.*$/gm, '')
    .replace(/https?:\/\/[^\s)]+/g, '');
}

function quotedSpans(body) {
  return [...String(body || '').matchAll(/(?:"([^"\n]{3,})"|“([^”\n]{3,})”|‘([^’\n]{3,})’)/g)].map(match => match[1] ?? match[2] ?? match[3]);
}

function quoteFindings(body, packet, draft) {
  const quoted = quotedSpans(body);
  const ledger = (packet.ledgers?.quotations || []).map(item => String(item.text || ''));
  const excerpts = [
    ...(packet.sources || []).map(item => retainedText(item)),
    ...(packet.claims || []).flatMap(claim => (claim.evidence || []).map(item => String(item.excerpt || '')))
  ];
  const directEvidence = new Set((draft.claim_support || []).filter(mapping => mapping.treatment === 'direct_quote').flatMap(mapping => mapping.evidence_ids || []));
  const evidenceById = new Map((packet.claims || []).flatMap(claim => (claim.evidence || []).map(item => [item.evidence_id, item])));
  const findings = [];
  for (const quote of quoted) {
    const supportedByPacket = ledger.some(value => value === quote) || excerpts.some(excerpt => excerpt.includes(quote));
    if (!supportedByPacket) findings.push(`Quote is not an exact contiguous substring of the frozen packet: “${quote}”`);
    if (supportedByPacket && ![...directEvidence].some(id => evidenceById.get(id)?.excerpt?.includes(quote))) findings.push(`Quote lacks a direct_quote evidence mapping: “${quote}”`);
  }
  for (const mapping of draft.claim_support || []) if (mapping.treatment === 'direct_quote' && !(quoted.some(quote => mapping.evidence_ids.some(id => evidenceById.get(id)?.excerpt?.includes(quote))))) findings.push(`Direct-quote mapping ${mapping.claim_id} has no exact quoted article text.`);
  return unique(findings);
}

function numberFindings(body, packet) {
  const allowed = new Set((packet.ledgers?.numbers || []).flatMap(item => String(item.value || '').match(/\d+(?:[.,]\d+)?%?/g) || []).map(value => value.replace(/,/g, '')));
  const parsed = parseArticleMarkdown(body);
  const occurrences = [];
  for (const value of `${parsed.headline}\n${parsed.dek}`.matchAll(/\b\d+(?:[.,]\d+)?%?\b/g)) occurrences.push({ value: value[0].replace(/,/g, ''), supported: false });
  for (const [index, paragraph] of articleBodyParagraphs(body).entries()) {
    const paragraphNumber = index + 1;
    const evidence = linkedEvidence({ draft: packet.__draft, packet, paragraphNumber });
    for (const value of readerVisibleText(paragraph).matchAll(/\b\d+(?:[.,]\d+)?%?\b/g)) {
      const normalizedValue = value[0].replace(/,/g, '');
      occurrences.push({ value: normalizedValue, supported: evidence.some(item => containsNumber(item.excerpt, normalizedValue)) });
    }
  }
  return unique(occurrences.filter(item => !allowed.has(item.value) && !item.supported).map(item => `Number is not present in the Terra number ledger: ${item.value}`));
}

function nameFindings(body, packet) {
  const allowed = new Set(approvedNames(packet));
  const candidates = [];
  for (const [index, paragraph] of articleBodyParagraphs(body).entries()) {
    const paragraphNumber = index + 1;
    const evidence = linkedEvidence({ draft: packet.__draft, packet, paragraphNumber });
    for (const match of readerVisibleText(paragraph).matchAll(new RegExp(`\\b${nameToken}(?:\\s+${nameToken})+\\b`, 'g'))) {
      const name = trimNameFillers(match[0]);
      const supported = allowed.has(normalized(name)) || evidence.some(item => containsName(item.excerpt, name));
      if (!supported) candidates.push(name);
    }
  }
  return unique(candidates.map(name => `Proper name is not present in the Terra name ledger: ${name}`));
}

function sourceFindings(draft, packet) {
  const validIds = new Set((packet.sources || []).map(source => source.source_id));
  const validClaimIds = new Set((packet.claims || []).map(claim => claim.claim_id));
  const validEvidenceIds = new Set((packet.claims || []).flatMap(claim => (claim.evidence || []).map(evidence => evidence.evidence_id)));
  const invalidClaims = (draft.claim_support || []).filter(mapping => !validClaimIds.has(mapping.claim_id)).map(mapping => `Draft names an unknown claim ID: ${mapping.claim_id}`);
  const claimProblems = (draft.claim_support || []).flatMap(mapping => {
    const local = [];
    for (const evidenceId of mapping.evidence_ids || []) if (!validEvidenceIds.has(evidenceId)) local.push(`Claim ${mapping.claim_id} names an unknown evidence ID: ${evidenceId}`);
    return local;
  });
  return unique([...((draft.source_ids || []).filter(id => !validIds.has(id)).map(id => `Draft names an unknown source ID: ${id}`)), ...invalidClaims, ...claimProblems]);
}

function constraintFindings(body, constraints = []) {
  const article = normalized(body);
  const findings = [];
  for (const constraint of constraints || []) {
    const match = String(constraint).match(/\bdo not (?:claim|say|describe)\s+(.+)/i);
    if (!match) continue;
    const forbidden = match[1].split(/\s+(?:unless|without|except)\b/i)[0].replace(/[.;:,]+$/, '').trim();
    if (forbidden.length >= 8 && article.includes(normalized(forbidden))) findings.push(`Draft violates frozen constraint: ${constraint}`);
  }
  return unique(findings);
}

function repeatedSentences(body) {
  const seen = new Map();
  for (const sentence of String(body || '').split(/[.!?]+/).map(normalized).filter(value => value.length > 35)) seen.set(sentence, (seen.get(sentence) || 0) + 1);
  return [...seen.entries()].filter(([, count]) => count > 1).map(([sentence]) => `Repeated sentence: ${sentence}`);
}

function paragraphStats(body) {
  const paragraphs = String(body || '').split(/\n\s*\n/).map(clean).filter(Boolean);
  const counts = paragraphs.map(item => words(item.replace(/^#{1,6}\s+/, '')).length);
  return { paragraph_count: paragraphs.length, word_counts: counts, longest_paragraph_words: Math.max(0, ...counts), shortest_paragraph_words: Math.min(...counts.filter(Boolean), Infinity) === Infinity ? 0 : Math.min(...counts.filter(Boolean)) };
}

export function deterministicReview({ candidate = {}, draft = {}, packet = {}, form = null } = {}) {
  const article = String(draft.body_markdown || '');
  const formContract = form || STORY_FORM_BY_ID[candidate.commission?.story_form || candidate.classification?.story_form] || STORY_FORM_BY_ID.meanwhile;
  const blockingFactualErrors = [];
  const requiredEditorialFixes = [];
  const advisoryStyleWarnings = [];
  const normalizedArticle = normalized(article);

  for (const fact of packet.required_facts || []) if (fact.text && !normalizedArticle.includes(normalized(fact.text))) blockingFactualErrors.push(`Required fact is missing or materially changed: ${fact.text}`);
  for (const prohibited of packet.prohibited_claims || []) if (prohibited && normalizedArticle.includes(normalized(prohibited))) blockingFactualErrors.push(`Prohibited claim appears in the draft: ${prohibited}`);
  const reviewPacket = { ...packet, __draft: draft };
  blockingFactualErrors.push(...quoteFindings(article, packet, draft), ...numberFindings(article, reviewPacket), ...nameFindings(article, reviewPacket), ...sourceFindings(draft, packet), ...constraintFindings(article, packet.draft_constraints));
  requiredEditorialFixes.push(...repeatedSentences(article));

  const count = words(article).length;
  if (count < formContract.minimum || count > formContract.maximum) requiredEditorialFixes.push(`Draft word count ${count} is outside the ${formContract.name} range ${formContract.minimum}-${formContract.maximum}.`);
  if (!String(draft.headline || '').trim()) requiredEditorialFixes.push('Headline is required.');
  if (!String(draft.dek || '').trim()) requiredEditorialFixes.push('Dek is required.');
  const links = [...article.matchAll(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/g)].map(match => match[1]);
  const validUrls = new Set((packet.sources || []).flatMap(source => [source.url, source.canonical_url].filter(Boolean)));
  const invalidLinks = links.filter(link => !validUrls.has(link));
  if (invalidLinks.length) requiredEditorialFixes.push(...invalidLinks.map(link => `Inline link is outside the frozen packet: ${link}`));
  if ((article.match(/—/g) || []).length > 2) advisoryStyleWarnings.push('The draft uses several em dashes; review the cadence.');
  if (/\b(?:it'?s not .{1,80}, it'?s|not only .{1,80} but also)\b/i.test(article)) advisoryStyleWarnings.push('Review canned contrast phrasing.');
  if ((article.match(/^#{2,6}\s+/gm) || []).length > 5) advisoryStyleWarnings.push('The draft has many subheads for its length.');
  const expectedSection = candidate.commission?.section_id || candidate.classification?.primary_section;
  if (expectedSection && draft.section && expectedSection !== draft.section) advisoryStyleWarnings.push(`Draft section ${draft.section} does not match commissioned section ${expectedSection}.`);
  const expectedBeats = candidate.commission?.beats || candidate.classification?.recurring_beats || [];
  if (expectedBeats.length && (draft.beats || []).some(beat => !expectedBeats.includes(beat))) advisoryStyleWarnings.push('Draft beat metadata does not match the commissioned beats.');

  const sourceCount = (packet.sources || []).length;
  const schemaFindings = [];
  for (const field of ['headline', 'dek', 'body_markdown', 'claim_support', 'warnings']) if (!(field in draft)) schemaFindings.push(`Draft schema field is missing: ${field}`);
  blockingFactualErrors.push(...schemaFindings);
  return {
    status: blockingFactualErrors.length ? 'blocked' : requiredEditorialFixes.length || advisoryStyleWarnings.length ? 'review_recommended' : 'clear',
    checked_at: new Date().toISOString(),
    word_count: count,
    source_count: sourceCount,
    schema_findings: schemaFindings,
    blocking_factual_errors: unique(blockingFactualErrors),
    required_editorial_fixes: unique(requiredEditorialFixes),
    advisory_style_warnings: unique(advisoryStyleWarnings),
    paragraph_statistics: paragraphStats(article),
    link_findings: { count: links.length, invalid: invalidLinks },
    source_link_mode: 'deterministic_claim_links',
    repetition_findings: repeatedSentences(article),
    taxonomy_findings: advisoryStyleWarnings.filter(item => /section|beat metadata/i.test(item))
  };
}
