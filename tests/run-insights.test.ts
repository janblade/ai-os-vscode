import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { preparedContext, validPhaseContext, validUsage, phaseDuration } from '../src/core/run-insights';

test('prepared-input estimate counts UTF-8 bytes and keeps source revisions distinct from provider usage', () => {
  const sources=[{source:'.ai-os/memory/tasks/task.md',sha256:'a'.repeat(64)}];
  const context=preparedContext('Rules','Task ?',sources);
  assert.equal(context.bytes,new TextEncoder().encode('Rules\nTask ?').length);
  assert.equal(context.estimatedTokens,Math.ceil(context.bytes/4));
  assert.deepEqual(context.sources,sources); assert.equal(validPhaseContext(context),true);
  for(const invalid of [{...context,bytes:-1},{...context,estimatedTokens:NaN},{...context,sources:[{source:'task',sha256:'bad'}]}]) assert.equal(validPhaseContext(invalid),false);
  assert.equal(validUsage({inputTokens:100,outputTokens:20,cachedInputTokens:30}),true);
  for(const invalid of [{inputTokens:-1,outputTokens:0},{inputTokens:10},{inputTokens:Infinity,outputTokens:0},{inputTokens:0,outputTokens:1.5},{inputTokens:1,outputTokens:2,secret:'x'}]) assert.equal(validUsage(invalid),false);
  assert.equal(phaseDuration('2026-10-15T00:00:00Z','2026-10-15T00:01:05Z'),'1m 5s');
  assert.equal(phaseDuration(),'Not recorded');
});
