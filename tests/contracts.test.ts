import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { applyChange, exampleWorkflow, parseMessage, parseWorkflow, orderedNodes } from '../src/contracts';

test('round-trip edits preserve unknown fields and use stable node IDs', () => {
  const value = exampleWorkflow('flow');
  value.annotations = { future: true };
  value.nodes[0].config.extra = { keep: 1 };
  value.nodes[0].position.extra = 'keep';
  const changed = applyChange(parseWorkflow(JSON.stringify(value)), { kind: 'move', nodeId: 'plan', x: 37, y: 51 });
  assert.deepEqual(changed.annotations, value.annotations);
  assert.deepEqual(changed.nodes[0].config.extra, { keep: 1 });
  assert.equal(changed.nodes[0].position.extra, 'keep');
  assert.equal(changed.nodes[0].id, 'plan');
  assert.equal(value.nodes[0].position.x, 80);
});

test('reject invalid or unsupported graphs instead of executing a subset', () => {
  const invalid = [
    { ...exampleWorkflow('x'), version: 2 },
    { ...exampleWorkflow('x'), edges: [] },
    { ...exampleWorkflow('x'), nodes: [] },
  ];
  for (const value of invalid) assert.throws(() => parseWorkflow(JSON.stringify(value)));
  const cycle = exampleWorkflow('x');
  cycle.edges.push({ id: 'cycle', source: 'review', target: 'plan', sourcePort: 'success', targetPort: 'in' });
  assert.throws(() => orderedNodes(cycle));
  const unknown = exampleWorkflow('x');
  unknown.nodes[0].config.provider = 'unsupported';
  assert.throws(() => parseWorkflow(JSON.stringify(unknown)), /provider/);
});

test('webview boundary rejects paths, unrecognized actions and oversized or malformed data', () => {
  assert.deepEqual(parseMessage({ type: 'ready' }), { type: 'ready' });
  for (const body of [null, [], { type: 'shell', command: 'anything' }, { type: 'run', revision: -1 },
    { type: 'update', revision: 1, change: { kind: 'move', nodeId: '../x', x: Infinity, y: 2 } },
    { type: 'update', revision: 1, change: { kind: 'rename', name: 'a'.repeat(201) } },
    { type: 'run', revision: 1, path: '../outside' }]) assert.throws(() => parseMessage(body));
});

test('linear append/remove reconnects dependencies and preserves existing edge fields', () => {
  const value = exampleWorkflow('x');
  value.edges[0].annotation = 'keep';
  const appended = applyChange(value, { kind: 'append', nodeKind: 'agent' }, 'new-step');
  assert.deepEqual(orderedNodes(appended).map(n => n.id), ['plan', 'review', 'new-step']);
  assert.equal(appended.edges[0].annotation, 'keep');
  const removed = applyChange(appended, { kind: 'remove', nodeId: 'review' });
  assert.deepEqual(orderedNodes(removed).map(n => n.id), ['plan', 'new-step']);
});
