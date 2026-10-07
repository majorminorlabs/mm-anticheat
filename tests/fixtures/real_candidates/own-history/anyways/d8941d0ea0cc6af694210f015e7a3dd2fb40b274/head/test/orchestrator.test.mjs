import assert from 'node:assert/strict';
import test from 'node:test';
import { CandidateOrchestrator, articleDiagnostics, parseArticleMarkdown } from '../src/pipeline/orchestrator.mjs';
import { REVIEW_PACKAGE_INTEGRITY_FAILED, documentsForCandidateRun, validateReviewPackage } from '../src/pipeline/integrity.mjs';
import { STORY_FORM_BY_ID } from '../src/editorial.mjs';

const makeCandidate = (id, title) => ({ id, url:`https://example.test/${id}`, title, description:`Evidence about ${title}`, status:'pitch_ready', history:[], commission:{ brief:`Why ${title} matters`, section_id:'internet', story_form:'meanwhile', beats:[], tags:[], notes:'Test pitch', source_urls:[`https://example.test/${id}`] }, classification:{ primary_section:'internet', recurring_beats:[], tags:[], editorial_pitch:{ accepted:true } } });
const writer = {
  model: 'gpt-5.6-sol',
  async write() {
    return { model: 'gpt-5.6-sol', markdown: '# A useful headline\n\n*A source-backed dek.*\n\nThis short draft reaches review even though it needs more evidence and length work.' };
  }
};
const router = { search:async () => ({ results:[], warnings:[], coverage:{ shouldEscalate:false } }), fetchPages:async () => ({ pages:[], warnings:[] }), summary:() => ({ searchRequests:0, cachedSearches:0, pagesFetched:0, providerUsage:{}, estimatedSearchCostUsd:0, budgetReached:false, entries:[] }) };
const makeOrchestrator = () => new CandidateOrchestrator({ writer, fetcher:async url => ({ ok:true, url, canonical_url:url, text:`Evidence specific to ${url}`, raw:'<meta property="og:image" content="https://example.test/image.jpg">' }), researchRouter:router });
const makeState = candidates => ({candidates,clusters:[],documents:[],research_packets:[],reviews:[],review_actions:[],runs:[]});
const authorization = { job_id: 'commissioned-job' };

test('candidate processing saves Markdown to AI Review even when advisory checks find problems', async () => {
  const candidate = makeCandidate('c1', 'A system changes');
  const state = makeState([candidate]);
  const result = await makeOrchestrator().process({state,candidateId:'c1',commissionAuthorization:authorization});
  assert.equal(result.candidate.status,'ready_for_review');
  assert.equal(state.reviews.length,1);
  assert.equal(result.review.model,'gpt-5.6-sol');
  assert.equal(result.review.headline,'A useful headline');
  assert.ok(result.review.classification.review_warnings.length);
  assert.ok(result.review.classification.revision_suggestions.length);
  assert.equal(state.documents[0].candidate_id,'c1');
  assert.equal(state.documents[0].processing_run_id,result.run.id);
  assert.match(state.documents[0].id, /^source:c1:/);
  const resumed=await makeOrchestrator().process({state,candidateId:'c1',commissionAuthorization:authorization});
  assert.equal(resumed.resumed,true);
});

test('plain Markdown parser uses deterministic title and dek fallbacks without rejecting the article', () => {
  const article = parseArticleMarkdown('A body without the requested wrapper.', { title:'Fallback title', description:'Fallback dek' });
  assert.equal(article.headline,'Fallback title');
  assert.equal(article.dek,'Fallback dek');
  assert.equal(article.body,'A body without the requested wrapper.');
  assert.equal(article.metadata.supplied_heading,false);
  assert.equal(article.metadata.supplied_dek,false);
});

test('post-write diagnostics are warnings and suggestions, not advancement gates', () => {
  const article = parseArticleMarkdown('# H\n\n*D*\n\nTiny draft.', { title:'Fallback' });
  const diagnostics = articleDiagnostics({ article, documents:[{ url:'https://example.test/a', canonical_url:'https://example.test/a', source_type:'candidate_primary' }], form:STORY_FORM_BY_ID.meanwhile, searchWarnings:[] });
  assert.equal(diagnostics.status,'review_recommended');
  assert.match(diagnostics.evidence_warnings.join('\n'), /at least 3 sources/);
  assert.match(diagnostics.revision_suggestions.join('\n'), /draft is 2 words/i);
});

test('two candidates processed sequentially retain distinct document and image ownership', async () => {
  const a=makeCandidate('a','Solar eclipse'), b=makeCandidate('b','Oregon wildfire');
  const state=makeState([a,b]);
  const o=makeOrchestrator();
  const ra=await o.process({state,candidateId:'a',commissionAuthorization:authorization});
  const rb=await o.process({state,candidateId:'b',commissionAuthorization:authorization});
  assert.notEqual(state.documents[0].id,state.documents[1].id);
  assert.equal(ra.review.document_ids.every(id => state.documents.find(doc => doc.id === id)?.candidate_id === 'a'),true);
  assert.equal(rb.review.document_ids.every(id => state.documents.find(doc => doc.id === id)?.candidate_id === 'b'),true);
  assert.equal(rb.review.images.every(image => image.candidate_id === 'b'),true);
});

test('concurrent processing cannot share mutable candidate artifacts', async () => {
  const a=makeCandidate('a','Solar eclipse'), b=makeCandidate('b','Oregon wildfire');
  const state=makeState([a,b]);
  const o=makeOrchestrator();
  const [ra, rb]=await Promise.all([o.process({state,candidateId:'a',commissionAuthorization:authorization}),o.process({state,candidateId:'b',commissionAuthorization:authorization})]);
  assert.deepEqual(new Set(ra.review.document_ids).intersection(new Set(rb.review.document_ids)),new Set());
  assert.notEqual(ra.run.id,rb.run.id);
});

test('regeneration creates a new candidate run without importing earlier artifacts', async () => {
  const a=makeCandidate('a','Solar eclipse');
  const state=makeState([a]);
  const o=makeOrchestrator();
  const first=await o.process({state,candidateId:'a',commissionAuthorization:authorization});
  const second=await o.process({state,candidateId:'a',resume:false,commissionAuthorization:authorization});
  assert.notEqual(first.run.id,second.run.id);
  assert.equal(second.review.document_ids.every(id => state.documents.find(doc => doc.id === id)?.processing_run_id === second.run.id),true);
  assert.equal(second.review.document_ids.some(id => first.review.document_ids.includes(id)),false);
});

test('candidate processing carries router-expanded pages into its source packet', async () => {
  const candidate = makeCandidate('expanded','Solar eclipse');
  const state=makeState([candidate]);
  const expanded = { search:async () => ({ results:[{ title:'Solar eclipse primary record', url:'https://records.example.test/eclipse', provider:'brave' }], warnings:[], coverage:{ shouldEscalate:false } }), fetchPages:async () => ({ pages:[{ ok:true, canonical_url:'https://records.example.test/eclipse', url:'https://records.example.test/eclipse', title:'Solar eclipse primary record', text:'Solar eclipse evidence from an independent record', raw:'', search_result:{ title:'Solar eclipse primary record', url:'https://records.example.test/eclipse', provider:'brave' } }], warnings:[] }), summary:() => ({ searchRequests:1, cachedSearches:0, pagesFetched:1, providerUsage:{brave:1}, estimatedSearchCostUsd:0, budgetReached:false, entries:[] }) };
  const orchestrator = new CandidateOrchestrator({ writer, fetcher:async url => ({ ok:true, url, canonical_url:url, text:`Solar eclipse evidence ${url}`, raw:'' }), researchRouter:expanded });
  const outcome = await orchestrator.process({ state, candidateId:'expanded', commissionAuthorization:authorization });
  assert.equal(outcome.review.document_ids.length, 2);
  assert.equal(state.research_packets[0].search_usage.providerUsage.brave, 1);
});

test('writer failures return an actionable error without pretending review exists', async () => {
  const candidate = makeCandidate('failed','Solar eclipse');
  const state=makeState([candidate]);
  const failing = new CandidateOrchestrator({ writer:{ model:'gpt-5.6-sol', write:async () => { throw new Error('authentication expired'); } }, fetcher:async url => ({ ok:true, url, canonical_url:url, text:'Solar eclipse evidence', raw:'' }), researchRouter:router });
  const outcome = await failing.process({ state, candidateId:'failed', commissionAuthorization:authorization });
  assert.equal(outcome.candidate.status,'research_blocked');
  assert.equal(outcome.error.code,'WRITER_FAILED');
  assert.match(outcome.error.message,/authentication expired/);
  assert.equal(state.reviews.length,0);
});

test('a selected writer configures the legacy orchestrator without the local default', () => {
  const orchestrator = new CandidateOrchestrator({ writerSelection: { writer: 'sol-medium', length: 'feature' } });
  assert.equal(orchestrator.writer.model, 'gpt-5.6-sol');
  assert.equal(orchestrator.writer.reasoningEffort, 'medium');
  assert.equal(orchestrator.writer.writerLengthLabel, 'Feature');
});

test('candidate processing fails closed without a controller commission claim', async () => {
  const candidate = makeCandidate('unclaimed', 'A system changes');
  await assert.rejects(
    makeOrchestrator().process({ state: makeState([candidate]), candidateId: candidate.id }),
    error => error.code === 'PITCH_NOT_COMMISSIONABLE'
  );
});

test('raw, rejected, and malformed pitch candidates cannot begin reporting', async () => {
  for (const status of ['discovered', 'watching', 'rejected', 'rejected_by_editor', 'archived']) {
    const candidate = { ...makeCandidate(`blocked-${status}`, 'A system changes'), status };
    await assert.rejects(
      makeOrchestrator().process({ state: makeState([candidate]), candidateId: candidate.id, commissionAuthorization: authorization }),
      error => error.code === 'PITCH_NOT_COMMISSIONABLE'
    );
  }
  const malformed = makeCandidate('malformed', 'A system changes');
  malformed.classification.editorial_pitch.accepted = false;
  await assert.rejects(
    makeOrchestrator().process({ state: makeState([malformed]), candidateId: malformed.id, commissionAuthorization: authorization }),
    error => error.code === 'PITCH_NOT_COMMISSIONABLE'
  );
});

test('integrity validation fails closed for cross-candidate claims and images', () => {
  const candidate=makeCandidate('a','Solar eclipse');
  const run={id:'run-a',candidate_id:'a'};
  const document={id:'source:a:run-a:1',candidate_id:'a',processing_run_id:'run-a',url:candidate.url,retention:{score:100,reason:'candidate_canonical_url'}};
  const review={candidate_id:'a',processing_run_id:'run-a',document_ids:[document.id],claims:[{claim:'bad',candidate_id:'b',processing_run_id:'run-b',source_ids:['source:b:run-b:1']}],images:[{original_url:'https://example.test/x.jpg',candidate_id:'b',processing_run_id:'run-b',source_document_id:'source:b:run-b:1'}]};
  const result=validateReviewPackage({candidate,run,documents:[document],review});
  assert.equal(result.ok,false);
  assert.equal(result.code,REVIEW_PACKAGE_INTEGRITY_FAILED);
  assert.match(result.errors.join('\n'), /claim ownership mismatch/);
  assert.match(result.errors.join('\n'), /image ownership mismatch/);
});

test('the eclipse package cannot select a same-id document owned by another run', () => {
  const documents = [
    { id:'science_news_article', candidate_id:'oregon', processing_run_id:'run-oregon', title:'Smoke Blankets Oregon' },
    { id:'science_news_article', candidate_id:'eclipse', processing_run_id:'run-eclipse', title:'NASA Science Soars During August Total Solar Eclipse' }
  ];
  assert.deepEqual(documentsForCandidateRun({ documents }, 'eclipse', 'run-eclipse').map(item => item.title), ['NASA Science Soars During August Total Solar Eclipse']);
});

test('review actions and revisions are audited and never publish', () => {
  const candidate=makeCandidate('c1','A system changes');
  const state={candidates:[{...candidate,status:'ready_for_review',history:[]}],review_actions:[]};
  const o=new CandidateOrchestrator();
  o.requestRevision({state,candidateId:'c1',actor:'editor',instructions:'Tighten the evidence.'});
  assert.equal(state.candidates[0].status,'revision_requested');
  state.candidates[0].status='ready_for_review';
  o.reviewAction({state,candidateId:'c1',actor:'editor',action:'approve'});
  assert.equal(state.candidates[0].status,'approved');
  assert.equal(state.review_actions.length,2);
});
