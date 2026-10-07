import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { buildArticlePrompt, CodexWriterAdapter, LocalArticleWriterAdapter, codexWriterArgs } from '../src/pipeline/codex-writer.mjs';
import { STORY_FORM_BY_ID } from '../src/editorial.mjs';

test('Terra pitch invocation is ephemeral, read-only, and explicitly model-pinned', () => {
  const args = codexWriterArgs({ model:'gpt-5.6-terra', reasoningEffort:'medium', workingDirectory:'/tmp' });
  assert.deepEqual(args.slice(0, 4), ['exec','--ephemeral','--ignore-user-config','--ignore-rules']);
  assert.ok(args.includes('--sandbox'));
  assert.ok(args.includes('read-only'));
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-5.6-terra');
  assert.equal(args[args.indexOf('--config') + 1], 'model_reasoning_effort="medium"');
  assert.equal(args.at(-1), '-');
});

test('article writing uses the local Ollama adapter instead of Codex', async () => {
  const calls = [];
  const writer = new LocalArticleWriterAdapter({
    model: 'qwen3:14b',
    adapter: { async generate(request) { calls.push(request); return { raw: '# Local headline\n\n*Local dek*\n\nLocal body.', metrics: { eval_count: 12 } }; } }
  });
  const response = await writer.write({ brief: 'Explain the practical change.', section: 'systems', form: STORY_FORM_BY_ID.meanwhile, sources: [{ title: 'Official notice', url: 'https://example.test/notice', content: 'The notice took effect Tuesday.' }] });
  assert.equal(response.model, 'qwen3:14b');
  assert.equal(response.markdown, '# Local headline\n\n*Local dek*\n\nLocal body.');
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /Write one publication-ready Anyways article/);
});

test('writer prompt asks for a lens-led Anyways article and supplies source URLs and extracted text', () => {
  const prompt = buildArticlePrompt({ brief:'Explain the practical change.', section:'systems', form:STORY_FORM_BY_ID.meanwhile, sources:[{ title:'Official notice', url:'https://example.test/notice', content:'The notice took effect Tuesday.' }] });
  assert.match(prompt,/Return plain Markdown only/);
  assert.doesNotMatch(prompt,/Return JSON only/);
  assert.match(prompt,/https:\/\/example\.test\/notice/);
  assert.match(prompt,/The notice took effect Tuesday/);
  assert.match(prompt,/untrusted quoted material/);
  assert.match(prompt,/Editorial question: How do complicated and influential things actually work\?/);
  assert.match(prompt,/Anyways is not a wire service/);
  assert.match(prompt,/Never open with the form name, “Meanwhile,”/);
});

test('pitch model timeouts reject instead of returning an advanceable pitch', async () => {
  let killed = false;
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { killed = true; };
    return child;
  };
  const writer = new CodexWriterAdapter({ spawnImpl, timeoutMs: 5 });
  await assert.rejects(
    writer.pitch({ candidate: { title: 'A lead', description: 'A raw lead', url: 'https://example.test' }, section: 'systems', requestedForm: 'meanwhile' }),
    /timed out/
  );
  assert.equal(killed, true);
});
