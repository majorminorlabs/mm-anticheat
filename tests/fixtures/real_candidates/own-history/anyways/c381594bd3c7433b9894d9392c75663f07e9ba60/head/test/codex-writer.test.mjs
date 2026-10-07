import assert from 'node:assert/strict';
import test from 'node:test';
import { buildArticlePrompt, codexWriterArgs } from '../src/pipeline/codex-writer.mjs';
import { STORY_FORM_BY_ID } from '../src/editorial.mjs';

test('SOL writer invocation is ephemeral, read-only, and explicitly model-pinned', () => {
  const args = codexWriterArgs({ model:'gpt-5.6-sol', reasoningEffort:'medium', workingDirectory:'/tmp' });
  assert.deepEqual(args.slice(0, 4), ['exec','--ephemeral','--ignore-user-config','--ignore-rules']);
  assert.ok(args.includes('--sandbox'));
  assert.ok(args.includes('read-only'));
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-5.6-sol');
  assert.equal(args[args.indexOf('--config') + 1], 'model_reasoning_effort="medium"');
  assert.equal(args.at(-1), '-');
});

test('writer prompt asks for plain Markdown and supplies source URLs and extracted text', () => {
  const prompt = buildArticlePrompt({ brief:'Explain the practical change.', form:STORY_FORM_BY_ID.meanwhile, sources:[{ title:'Official notice', url:'https://example.test/notice', content:'The notice took effect Tuesday.' }] });
  assert.match(prompt,/Return plain Markdown only/);
  assert.doesNotMatch(prompt,/Return JSON only/);
  assert.match(prompt,/https:\/\/example\.test\/notice/);
  assert.match(prompt,/The notice took effect Tuesday/);
  assert.match(prompt,/untrusted quoted material/);
});
