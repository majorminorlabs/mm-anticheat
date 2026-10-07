import assert from 'node:assert/strict';
import test from 'node:test';
import { CandidateOrchestrator } from '../src/pipeline/orchestrator.mjs';
import { REVIEW_PACKAGE_INTEGRITY_FAILED, documentsForCandidateRun, validateReviewPackage } from '../src/pipeline/integrity.mjs';

const makeCandidate = (id, title) => ({ id, url:`https://example.test/${id}`, title, description:`Evidence about ${title}`, status:'discovered', history:[] });
const stageResult = sourceId => ({ run_id:'run1', model:'qwen3:14b', status:'complete', stages:{ research_plan:{output:{}}, synthesis:{output:{}}, draft:{output:{headline:'H',dek:'D',body_markdown:'Draft',claim_to_source:[{claim:'C',source_ids:[sourceId]}]}}, verification:{output:{claims:[{claim:'C',status:'supported',source_ids:[sourceId],note:'Supported'}]}}, proofreading:{output:{}}, slop:{output:{revised_body:'Final',changes:[],warnings:[]}} } });
const makeOrchestrator = () => new CandidateOrchestrator({ pipeline:{ run:async ({ sources }) => stageResult(sources[0].id) }, synthesis:{ run:async ({ sources }) => ({ status:'passed', output:{ claim_to_source:[{claim:'C',source_ids:[sources[0].id]}] } }) }, fetcher:async url => ({ ok:true, url, canonical_url:url, text:`Evidence specific to ${url}`, raw:'<meta property="og:image" content="https://example.test/image.jpg">' }) });

test('candidate processing produces a run-isolated ready review package and resumes idempotently', async () => {
  const candidate = makeCandidate('c1', 'A system changes'); const state={candidates:[candidate],clusters:[{candidates:[candidate]}],documents:[],research_packets:[],reviews:[],review_actions:[],runs:[]};
  const result=await makeOrchestrator().process({state,candidateId:'c1'});
  assert.equal(result.candidate.status,'ready_for_review'); assert.equal(state.reviews.length,1); assert.equal(state.documents[0].candidate_id,'c1'); assert.equal(state.documents[0].processing_run_id,result.run.id); assert.match(state.documents[0].id, /^source:c1:/);
  const resumed=await makeOrchestrator().process({state,candidateId:'c1'}); assert.equal(resumed.resumed,true);
});

test('two candidates processed sequentially retain distinct document, claim, and image ownership', async () => {
  const a=makeCandidate('a','Solar eclipse'), b=makeCandidate('b','Oregon wildfire'); const state={candidates:[a,b],clusters:[],documents:[],research_packets:[],reviews:[],review_actions:[],runs:[]}; const o=makeOrchestrator();
  const ra=await o.process({state,candidateId:'a'}); const rb=await o.process({state,candidateId:'b'});
  assert.notEqual(state.documents[0].id,state.documents[1].id); assert.equal(ra.review.document_ids.every(id => state.documents.find(doc => doc.id === id)?.candidate_id === 'a'),true); assert.equal(rb.review.document_ids.every(id => state.documents.find(doc => doc.id === id)?.candidate_id === 'b'),true); assert.equal(ra.review.claims.every(claim => claim.candidate_id === 'a'),true); assert.equal(rb.review.images.every(image => image.candidate_id === 'b'),true);
});

test('concurrent processing cannot share mutable candidate artifacts', async () => {
  const a=makeCandidate('a','Solar eclipse'), b=makeCandidate('b','Oregon wildfire'); const state={candidates:[a,b],clusters:[],documents:[],research_packets:[],reviews:[],review_actions:[],runs:[]}; const o=makeOrchestrator();
  const [ra, rb]=await Promise.all([o.process({state,candidateId:'a'}),o.process({state,candidateId:'b'})]);
  assert.deepEqual(new Set(ra.review.document_ids).intersection(new Set(rb.review.document_ids)),new Set()); assert.notEqual(ra.run.id,rb.run.id);
});

test('regeneration creates a new candidate run without importing earlier artifacts', async () => {
  const a=makeCandidate('a','Solar eclipse'); const state={candidates:[a],clusters:[],documents:[],research_packets:[],reviews:[],review_actions:[],runs:[]}; const o=makeOrchestrator();
  const first=await o.process({state,candidateId:'a'}); const second=await o.process({state,candidateId:'a',resume:false});
  assert.notEqual(first.run.id,second.run.id); assert.equal(second.review.document_ids.every(id => state.documents.find(doc => doc.id === id)?.processing_run_id === second.run.id),true); assert.equal(second.review.document_ids.some(id => first.review.document_ids.includes(id)),false);
});

test('integrity validation fails closed for cross-candidate claims and images', () => {
  const candidate=makeCandidate('a','Solar eclipse'); const run={id:'run-a',candidate_id:'a'}; const document={id:'source:a:run-a:1',candidate_id:'a',processing_run_id:'run-a',url:candidate.url,retention:{score:100,reason:'candidate_canonical_url'}};
  const review={candidate_id:'a',processing_run_id:'run-a',document_ids:[document.id],claims:[{claim:'bad',candidate_id:'b',processing_run_id:'run-b',source_ids:['source:b:run-b:1']}],images:[{original_url:'https://example.test/x.jpg',candidate_id:'b',processing_run_id:'run-b',source_document_id:'source:b:run-b:1'}]};
  const result=validateReviewPackage({candidate,run,documents:[document],review}); assert.equal(result.ok,false); assert.equal(result.code,REVIEW_PACKAGE_INTEGRITY_FAILED); assert.match(result.errors.join('\n'), /claim ownership mismatch/); assert.match(result.errors.join('\n'), /image ownership mismatch/);
});

test('the eclipse package cannot select the Smoke Blankets Oregon document with the same legacy source id', () => {
  const documents = [
    { id:'science_news_article', candidate_id:'oregon', processing_run_id:'run-oregon', title:'Smoke Blankets Oregon' },
    { id:'science_news_article', candidate_id:'eclipse', processing_run_id:'run-eclipse', title:'NASA Science Soars During August Total Solar Eclipse' }
  ];
  assert.deepEqual(documentsForCandidateRun({ documents }, 'eclipse', 'run-eclipse').map(item => item.title), ['NASA Science Soars During August Total Solar Eclipse']);
});

test('review actions and revisions are audited and never publish', () => { const candidate=makeCandidate('c1','A system changes'); const state={candidates:[{...candidate,status:'ready_for_review',history:[]}],review_actions:[]}; const o=new CandidateOrchestrator(); o.requestRevision({state,candidateId:'c1',actor:'editor',instructions:'Tighten the evidence.'}); assert.equal(state.candidates[0].status,'revision_requested'); state.candidates[0].status='ready_for_review'; o.reviewAction({state,candidateId:'c1',actor:'editor',action:'approve'}); assert.equal(state.candidates[0].status,'approved'); assert.equal(state.review_actions.length,2); });
