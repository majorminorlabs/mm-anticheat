import crypto from 'node:crypto';
import { fetchDocument } from './acquisition.mjs';
import { LocalArticleWriterAdapter } from './codex-writer.mjs';
import { transition } from './state.mjs';
import { sourceRetention, validateReviewPackage } from './integrity.mjs';
import { ResearchRouter } from './research-router.mjs';
import { STORY_FORM_BY_ID } from '../editorial.mjs';

export const RESEARCH_LIMITS = Object.freeze({ rounds: 2, queriesPerRound: 3, documents: 20, sourceChars: 5_000, failedFetches: 3, runtimeMs: 480_000 });
const now = () => new Date().toISOString();
const compact = value => String(value || '').replace(/\s+/g, ' ').trim();
const words = value => String(value || '').trim().split(/\s+/).filter(Boolean);
const primaryResearchUrl = value => { try { return /\.(gov|edu)$/i.test(new URL(value).hostname) || /(?:sec\.gov|justice\.gov|congress\.gov|who\.int|europa\.eu|arxiv\.org|nih\.gov)$/i.test(new URL(value).hostname); } catch { return false; } };
const unique = values => [...new Set(values.filter(Boolean))];
const host = value => { try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return ''; } };

function unwrapMarkdown(value) {
  const text = String(value || '').trim();
  const fenced = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  return (fenced ? fenced[1] : text).trim();
}

function fallbackDek(candidate, body) {
  const supplied = compact(candidate.description).slice(0, 240);
  if (supplied) return supplied;
  const paragraph = body.split(/\n\s*\n/).map(compact).find(value => value && !value.startsWith('#')) || '';
  return paragraph.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').slice(0, 240) || 'A source-backed draft prepared for editorial review.';
}

export function parseArticleMarkdown(markdown, candidate = {}) {
  const raw = unwrapMarkdown(markdown);
  const lines = raw.split(/\r?\n/);
  const headingIndex = lines.findIndex(line => /^#\s+\S/.test(line));
  const headline = compact(headingIndex >= 0 ? lines[headingIndex].replace(/^#\s+/, '') : candidate.title).slice(0, 180) || 'Untitled article';
  if (headingIndex >= 0) lines.splice(headingIndex, 1);
  while (!lines[0]?.trim()) lines.shift();
  let dek = '';
  if (/^(?:\*[^*].*\*|_[^_].*_)$/.test(lines[0]?.trim() || '')) {
    dek = compact(lines.shift().trim().slice(1, -1)).slice(0, 300);
    while (!lines[0]?.trim()) lines.shift();
  }
  const body = lines.join('\n').trim() || raw;
  return {
    headline,
    dek: dek || fallbackDek(candidate, body),
    body,
    metadata: {
      supplied_heading: headingIndex >= 0,
      supplied_dek: Boolean(dek),
      looked_like_json: /^[{[]/.test(raw)
    }
  };
}

export function articleDiagnostics({ article, documents, form, searchWarnings = [] }) {
  const evidenceWarnings = unique(searchWarnings.map(warning => compact(warning.message || warning)).filter(Boolean));
  const revisionSuggestions = [];
  const sourceDomains = unique(documents.map(document => host(document.canonical_url || document.url)));
  const primarySources = documents.filter(document => document.source_type === 'primary_research' || primaryResearchUrl(document.url));
  const markdownLinks = [...article.body.matchAll(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/g)].map(match => match[1]);
  const count = words(article.body).length;

  if (documents.length < form.minimumSources) evidenceWarnings.push(`The ${form.name} source guide recommends at least ${form.minimumSources} sources; this package contains ${documents.length}.`);
  if (!primarySources.length) evidenceWarnings.push('No clearly identified primary source is present in the source packet.');
  if (sourceDomains.length < 2) evidenceWarnings.push('The source packet does not yet contain two independent domains.');
  if (!markdownLinks.length) evidenceWarnings.push('The draft contains no inline source links. Verify material claims against the linked source list.');
  if (article.metadata.looked_like_json) evidenceWarnings.push('The writer output resembles JSON and should be reformatted during review.');
  if (!article.metadata.supplied_heading) revisionSuggestions.push('The writer omitted an H1 headline, so the discovered candidate title was used.');
  if (!article.metadata.supplied_dek) revisionSuggestions.push('The writer omitted the requested italic dek, so a deterministic fallback was used.');
  if (count < form.minimum || count > form.maximum) revisionSuggestions.push(`The draft is ${count} words; the ${form.name} guide is ${form.minimum}-${form.maximum}.`);
  if ((article.body.match(/—/g) || []).length > 2) revisionSuggestions.push('The draft uses several em dashes; review the cadence and replace any that feel mechanical.');
  if (/\b(?:it'?s not .{1,80}, it'?s|not only .{1,80} but also)\b/i.test(article.body)) revisionSuggestions.push('Review canned contrast phrasing for a more direct sentence.');
  if ((article.body.match(/^#{2,6}\s+/gm) || []).length > 5) revisionSuggestions.push('The draft has many subheads for its length; consider a simpler reading flow.');

  return {
    status: evidenceWarnings.length || revisionSuggestions.length ? 'review_recommended' : 'no_warnings',
    checked_at: now(),
    word_count: count,
    source_count: documents.length,
    independent_domain_count: sourceDomains.length,
    primary_source_count: primarySources.length,
    inline_source_link_count: markdownLinks.length,
    evidence_warnings: unique(evidenceWarnings),
    revision_suggestions: unique(revisionSuggestions)
  };
}

function classificationFor(candidate, form) {
  const existing = candidate.classification || {};
  const missingSection = !existing.primary_section;
  return {
    ...existing,
    primary_section: existing.primary_section || candidate.commission?.section_id || 'internet',
    recurring_beats: unique(existing.recurring_beats || candidate.commission?.beats || []),
    tags: unique(existing.tags || candidate.commission?.tags || []),
    story_form: form.id,
    story_form_contract: form,
    delivery_mode: 'article_first',
    ...(missingSection ? { classification_warning: 'Primary section defaulted to Internet; confirm it during review.' } : {})
  };
}

async function deliverArticleFirst({ writer, state, candidate, run, documents, brief, actor, packet }) {
  const form = STORY_FORM_BY_ID[candidate.commission?.story_form || candidate.classification?.story_form] || STORY_FORM_BY_ID.meanwhile;
  const section = candidate.commission?.section_id || candidate.classification?.primary_section || 'internet';
  const response = await writer.write({ brief, sources: documents, form, section });
  const article = parseArticleMarkdown(response.markdown, candidate);
  const classification = { ...classificationFor(candidate, form), review_warnings: [], revision_suggestions: [] };
  const research = {
    delivery_mode: 'article_first',
    sources: packet.sources,
    search_usage: packet.search_usage,
    search_warnings: packet.search_warnings,
    diagnostics: { status: 'pending' }
  };
  const review = {
    id: crypto.randomUUID(),
    candidate_id: candidate.id,
    processing_run_id: run.id,
    document_ids: documents.map(document => document.id),
    status: 'ready_for_review',
    created_at: now(),
    model: response.model || writer.model,
    prompt_version: 'article-first-markdown-v1',
    headline: article.headline,
    dek: article.dek,
    article: article.body,
    previous_draft: article.body,
    classification,
    research,
    synthesis: { story_form: form.id, retained_source_ids: documents.map(document => document.id), delivery_mode: 'article_first' },
    claims: [],
    unresolved_claims: [],
    // Open Graph and publisher images are not image providers. The pipeline
    // must not turn arbitrary page artwork into image candidates. A dedicated
    // allowlisted-provider acquisition step may add deterministic records.
    images: [],
    logs: { writer: { model: response.model || writer.model, diagnostics: response.diagnostics || '' } },
    validation_history: {}
  };
  const integrity = validateReviewPackage({ candidate, run, documents, review });
  if (!integrity.ok) throw Object.assign(new Error(integrity.errors.join('; ')), { code: integrity.code, details: integrity });
  candidate.classification = classification;
  state.reviews.push(review);
  transition(candidate, 'ready_for_review', actor, 'Article saved; advisory checks follow');
  run.review_id = review.id;
  run.status = 'complete';
  run.finished_at = now();
  let diagnostics;
  try {
    diagnostics = articleDiagnostics({ article, documents, form, searchWarnings: packet.search_warnings });
  } catch (error) {
    diagnostics = {
      status: 'check_failed',
      checked_at: now(),
      evidence_warnings: [`Automatic checks could not complete: ${compact(error.message)}`],
      revision_suggestions: []
    };
  }
  classification.review_warnings = unique([classification.classification_warning, ...diagnostics.evidence_warnings]);
  classification.revision_suggestions = diagnostics.revision_suggestions;
  research.diagnostics = diagnostics;
  review.logs.post_write_checks = diagnostics;
  run.events.push({ type: 'review_package_created', review_id: review.id, warning_count: diagnostics.evidence_warnings.length, suggestion_count: diagnostics.revision_suggestions.length, at: run.finished_at });
  return { candidate, run, review, result: { status: 'complete', model: review.model, delivery_mode: 'article_first', diagnostics } };
}

export class CandidateOrchestrator {
  constructor({ writer = new LocalArticleWriterAdapter(), fetcher = fetchDocument, limits = RESEARCH_LIMITS, researchRouter = new ResearchRouter() } = {}) {
    this.writer = writer;
    this.fetcher = fetcher;
    this.limits = limits;
    this.researchRouter = researchRouter;
  }

  async process({ state, candidateId, actor = 'operator', resume = true, commissionAuthorization = null }) {
    for (const key of ['documents','research_packets','reviews','review_actions','runs','fetched_content_cache']) state[key] ||= [];
    const candidate = state.candidates.find(item => item.id === candidateId);
    if (!candidate) throw new Error('Candidate not found');
    if (candidate.status === 'ready_for_review' && resume) return { candidate, resumed: true };
    const resumable = !resume && ['research_blocked','verification_failed','ready_for_review'].includes(candidate.status);
    if ((!resumable && candidate.status !== 'pitch_ready')
      || candidate.classification?.editorial_pitch?.accepted !== true
      || !candidate.commission
      || !commissionAuthorization?.job_id) {
      throw Object.assign(new Error('Candidate must have an active editor commission before research can start.'), { code: 'PITCH_NOT_COMMISSIONABLE' });
    }

    if (process.env.ANYWAYS_SKIP_RESEARCH === '1') {
      const saved = state.documents.filter(document => document.candidate_id === candidateId);
      const latestRunId = saved.at(-1)?.processing_run_id;
      const priorDocuments = saved.filter(document => document.processing_run_id === latestRunId).slice(0, this.limits.documents);
      if (!priorDocuments.length) throw new Error('No saved research packet is available for article-first delivery.');
      const run = { id: crypto.randomUUID(), candidate_id: candidateId, type: 'article_first', started_at: now(), status: 'running', events: [{ type: 'saved_sources_reused', source_run_id: latestRunId, at: now() }] };
      state.runs.push(run);
      const documents = priorDocuments.map((document, index) => ({ ...document, id: `source:${candidateId}:${run.id}:${index + 1}`, processing_run_id: run.id }));
      state.documents.push(...documents);
      const brief = candidate.commission?.brief || `${candidate.title}\n${candidate.description || ''}`;
      const packet = { id: crypto.randomUUID(), candidate_id: candidateId, processing_run_id: run.id, iteration: 1, sources: documents.map(({ id,url,title,retention,source_type }) => ({ id,url,title,retention,source_type })), created_at: now(), search_usage: { reused: true }, search_warnings: [] };
      state.research_packets.push(packet);
      transition(candidate, 'researching', actor, 'Saved source packet reused');
      transition(candidate, 'drafting', actor, 'SOL Markdown drafting started');
      try { return await deliverArticleFirst({ writer: this.writer, state, candidate, run, documents, brief, actor, packet }); }
      catch (error) {
        run.status = 'blocked'; run.finished_at = now(); run.error = { code: 'WRITER_FAILED', message: error.message };
        transition(candidate, 'research_blocked', actor, `Writer failed: ${error.message}`);
        return { candidate, run, error: run.error };
      }
    }

    const run = { id: crypto.randomUUID(), candidate_id: candidateId, type: 'article_first', started_at: now(), status: 'running', events: [] };
    state.runs.push(run);
    transition(candidate, 'researching', actor, 'Source retrieval started');
    const cluster = { candidates: candidate.known_sources?.length ? candidate.known_sources : [candidate] };
    const documents = [];
    for (const source of cluster.candidates.slice(0, this.limits.documents)) {
      try {
        const fetched = await this.fetcher(source.url);
        run.events.push({ type: 'fetch', url: source.url, ok: fetched.ok, at: now(), error: fetched.error || null });
        if (!fetched.ok || !fetched.text?.trim()) continue;
        const doc = { id: `source:${candidateId}:${run.id}:${documents.length + 1}`, candidate_id: candidateId, processing_run_id: run.id, discovery_id: source.id, url: fetched.canonical_url || source.url, canonical_url: fetched.canonical_url || source.url, title: source.title, content: fetched.text.slice(0, this.limits.sourceChars), source_type: 'candidate_primary', retrieval_timestamp: fetched.fetched_at || now(), provenance: { discovery_id: source.id, fetched_url: source.url }, extraction: fetched };
        doc.retention = sourceRetention(candidate, doc);
        if (doc.retention.score <= 0) { run.events.push({ type: 'source_rejected', url: doc.url, reason: doc.retention.reason, at: now() }); continue; }
        documents.push(doc);
        state.fetched_content_cache.push({ canonical_url: doc.canonical_url, content_hash: crypto.createHash('sha256').update(doc.content).digest('hex'), fetched_at: doc.retrieval_timestamp });
      } catch (error) {
        run.events.push({ type: 'fetch', url: source.url, ok: false, error: error.message, at: now() });
      }
    }
    const brief = candidate.commission
      ? `${candidate.commission.brief}\n\nEDITOR ASSIGNMENT\nPrimary section: ${candidate.commission.section_id}\nRequested story form: ${candidate.commission.story_form}\nRecurring beats: ${candidate.commission.beats.join(', ') || 'none'}\nTags: ${candidate.commission.tags.join(', ') || 'none'}\nSupporting notes: ${candidate.commission.notes || 'none'}\nTreat the selected primary section and story form as fixed.`
      : `${candidate.title}\n${candidate.description || ''}`;
    const directResults = cluster.candidates.map(source => ({ title: source.title, url: source.url, snippet: source.description || '', provider: 'direct' }));
    const queries = [
      { text: candidate.title, type: 'news' },
      { text: `${candidate.title} official document`, type: 'primary' },
      { text: `${candidate.title} analysis criticism`, type: 'general' }
    ];
    const searched = [];
    const researchWarnings = [];
    for (const query of queries) {
      const result = await this.researchRouter.search(query, { storyId: candidateId, runId: run.id, purpose: 'research-expansion', directResults });
      searched.push(...result.results);
      researchWarnings.push(...result.warnings);
    }
    const unseenResults = searched.filter(result => !documents.some(document => document.canonical_url === result.url || document.url === result.url));
    const fetchedResearch = await this.researchRouter.fetchPages(unseenResults, { runId: run.id, fetcher: this.fetcher, maxPages: Math.max(0, this.limits.documents - documents.length) });
    researchWarnings.push(...fetchedResearch.warnings);
    for (const fetched of fetchedResearch.pages) {
      const source = fetched.search_result;
      const canonical = fetched.canonical_url || source.url;
      if (documents.some(document => document.canonical_url === canonical)) continue;
      const doc = { id: `source:${candidateId}:${run.id}:${documents.length + 1}`, candidate_id: candidateId, processing_run_id: run.id, discovery_id: null, url: canonical, canonical_url: canonical, title: fetched.title || source.title, content: fetched.text.slice(0, this.limits.sourceChars), source_type: source.provider === 'direct' ? 'candidate_primary' : primaryResearchUrl(source.url) ? 'primary_research' : 'research_expansion', retrieval_timestamp: fetched.fetched_at || now(), provenance: { provider: source.provider, query: candidate.title, fetched_url: source.url }, extraction: fetched };
      doc.retention = sourceRetention(candidate, doc);
      if (doc.retention.score > 0) documents.push(doc);
    }
    if (!documents.length) {
      transition(candidate, 'research_blocked', actor, 'No usable source pages were collected');
      run.status = 'blocked';
      run.finished_at = now();
      run.error = { code: 'NO_USABLE_SOURCES', message: 'No usable source pages were collected.' };
      return { candidate, run, error: run.error };
    }
    const packet = { id: crypto.randomUUID(), candidate_id: candidateId, processing_run_id: run.id, iteration: 1, sources: documents.map(({ id,url,title,retention,source_type }) => ({ id,url,title,retention,source_type })), created_at: now(), search_usage: this.researchRouter.summary(run.id), search_warnings: researchWarnings };
    state.documents.push(...documents);
    state.research_packets.push(packet);
    transition(candidate, 'ready_to_draft', actor, 'Source packet persisted');
    transition(candidate, 'drafting', actor, 'SOL Markdown drafting started');
    try {
      return await deliverArticleFirst({ writer: this.writer, state, candidate, run, documents, brief, actor, packet });
    } catch (error) {
      run.status = 'blocked';
      run.finished_at = now();
      run.error = { code: error.code || 'WRITER_FAILED', message: error.message, details: error.details || null };
      transition(candidate, 'research_blocked', actor, `Writer failed: ${error.message}`);
      return { candidate, run, error: run.error };
    }
  }

  requestRevision({ state, candidateId, actor, instructions }) {
    if (!instructions?.trim()) throw new Error('Revision instructions are required');
    const candidate = state.candidates.find(item => item.id === candidateId);
    if (!candidate) throw new Error('Candidate not found');
    transition(candidate, 'revision_requested', actor, instructions);
    state.review_actions.push({ id: crypto.randomUUID(), candidate_id: candidateId, actor, action: 'request_revision', previous_state: 'ready_for_review', new_state: 'revision_requested', notes: instructions, at: now() });
    return candidate;
  }

  reviewAction({ state, candidateId, actor, action, notes = '' }) {
    const allowed = new Map([['approve','approved'],['reject','rejected_by_editor'],['archive','archived']]);
    if (!allowed.has(action)) throw new Error('Unsupported review action');
    const candidate = state.candidates.find(item => item.id === candidateId);
    if (!candidate) throw new Error('Candidate not found');
    const previous = candidate.status;
    transition(candidate, allowed.get(action), actor, notes);
    state.review_actions.push({ id: crypto.randomUUID(), candidate_id: candidateId, actor, action, previous_state: previous, new_state: candidate.status, notes, at: now() });
    return candidate;
  }
}
