import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPitchPrompt, commodityLeadReason, parseEditorialPitch } from '../src/pipeline/pitch.mjs';

const accepted = JSON.stringify({
  accepted: true,
  rejection_reason: '',
  headline: 'Europe Is Quietly Deciding Which Mouse You Can Buy',
  primary_section: 'systems',
  story_form: 'meanwhile',
  lens: 'Repair rules are making regional regulation a product-design decision for everyone else.',
  section_answer: 'The repair mandate shows how a regional compliance system quietly determines which hardware designs reach consumers elsewhere.',
  why_now: 'Logitech announced a Europe-only replaceable-battery model as the rules begin shaping new hardware.',
  reader_takeaway: 'A reader can see how right-to-repair turns a legal border into a different consumer future.',
  significance_tests: ['changes who has power', 'reveals a hidden system'],
  significance_rationales: {
    'changes who has power': 'Repair mandates shift product-design authority from manufacturers toward regulators and consumers.',
    'reveals a hidden system': 'Regional compliance decisions propagate through global hardware supply chains in ways buyers rarely see.'
  },
  evidence_plan: ['The applicable repair rule, its exact requirements, and effective date', 'Logitech product documentation describing the regional hardware differences', 'Comparable regional product decisions documented by manufacturers'],
  research_requirement: 'required'
});

test('pitch gate requires an actual editorial argument before a lead can advance', () => {
  const pitch = parseEditorialPitch(accepted, { requestedSection: 'systems', requestedForm: 'meanwhile' });
  assert.equal(pitch.accepted, true);
  assert.equal(pitch.primary_section, 'systems');
  assert.equal(pitch.significance_tests.length, 2);
  assert.equal(pitch.evidence_plan.length, 3);
});

test('pitch gate rejects malformed significance claims and preserves explicit editorial rejection', () => {
  const malformed = JSON.parse(accepted); malformed.significance_tests = ['interesting'];
  assert.throws(() => parseEditorialPitch(JSON.stringify(malformed)), /two unique valid significance tests/);
  assert.deepEqual(parseEditorialPitch(JSON.stringify({ accepted: false, rejection_reason: 'This is only a routine product update.', headline: '', primary_section: '', story_form: '', lens: '', section_answer: '', why_now: '', reader_takeaway: '', significance_tests: [], significance_rationales: {}, evidence_plan: [], research_requirement: '' })), { accepted: false, rejection_reason: 'This is only a routine product update.' });
  const duplicate = JSON.parse(accepted); duplicate.significance_tests = ['changes who has power', 'changes who has power'];
  assert.throws(() => parseEditorialPitch(JSON.stringify(duplicate)), /unique valid significance tests/);
  const badEvidence = JSON.parse(accepted); badEvidence.evidence_plan = [{ claim: 'A document' }, 'A source'];
  assert.throws(() => parseEditorialPitch(JSON.stringify(badEvidence)), /evidence plan items must be strings/);
  const extraKey = JSON.parse(accepted); extraKey.extra = 'nope';
  assert.throws(() => parseEditorialPitch(JSON.stringify(extraKey)), /exactly the declared schema/);
  const objectScalar = JSON.parse(accepted); objectScalar.lens = { claim: 'A hidden system' };
  assert.throws(() => parseEditorialPitch(JSON.stringify(objectScalar)), /lens as a non-empty string/);
  assert.throws(() => parseEditorialPitch(`Here is the pitch:\n${accepted}`), /one JSON object and no surrounding text/);
  const shallow = JSON.parse(accepted); shallow.evidence_plan = ['Look for evidence about the trend', 'Find some experts who can comment'];
  assert.throws(() => parseEditorialPitch(JSON.stringify(shallow)), /concrete proof/);
  const mismatch = JSON.parse(accepted); mismatch.significance_rationales = { 'changes who has power': mismatch.significance_rationales['changes who has power'] };
  assert.throws(() => parseEditorialPitch(JSON.stringify(mismatch)), /exactly match/);
  assert.throws(() => parseEditorialPitch(accepted, { requestedSection: 'media' }), /requested primary section/);
  assert.throws(() => parseEditorialPitch(accepted, { requestedForm: 'receipts' }), /requested story form/);
});

test('pitch prompt makes the distinction between a lead and an editorial opportunity explicit', () => {
  const prompt = buildPitchPrompt({ candidate: { title: 'Company launches a new product', description: '', url: 'https://example.test' }, section: 'systems', requestedForm: 'meanwhile' });
  assert.match(prompt, /This is not article writing/);
  assert.match(prompt, /A fact being recent is not a reason to cover it/);
  assert.match(prompt, /How do complicated and influential things actually work/);
  assert.match(prompt, /A quick observation, trend, or curiosity/);
  assert.equal(commodityLeadReason({ title: 'Startup raises a Series A' }), 'Funding is not an editorial premise.');
});
