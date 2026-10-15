import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { confirmationChoice, confirmationHtml, questionAnswer } from '../src/core/confirmation';
test('approval cards escape untrusted content and accept only an explicit offered choice', () => {
  const html = confirmationHtml('<img src=x onerror=alert(1)>', '</pre><script>bad()</script>', ['Allow once', 'Deny'], 'fixture');
  assert.ok(!html.includes('<img')); assert.ok(!html.includes('<script>bad')); assert.ok(html.includes('&lt;/pre&gt;'));
  assert.ok(html.includes("document.getElementById('cancel').focus()"));
  assert.equal(confirmationChoice({ type: 'confirmation', choice: 0 }, ['Allow once']), 'Allow once');
  assert.equal(confirmationChoice({ type: 'confirmation', choice: null }, ['Allow once']), null);
  for (const raw of [null, [], {}, {type:'other',choice:0}, {type:'confirmation',choice:-1}, {type:'confirmation',choice:1}, {type:'confirmation',choice:'0'}, {type:'confirmation',choice:0.5}]) assert.equal(confirmationChoice(raw, ['Allow once']), undefined);
});

test('agent question accepts bounded nonempty guidance and escapes public details', () => {
  const html = confirmationHtml('Decision <script>', 'Blocked </pre>', [], 'fixture', true);
  assert.match(html, /textarea/); assert.match(html, /maxlength="16000"/);
  assert.ok(!html.includes('Decision <script>'));
  assert.match(html, /type:'question'/);
  assert.equal(questionAnswer({ type: 'question', answer: ' Try focused tests ' }), 'Try focused tests');
  assert.equal(questionAnswer({ type: 'question', answer: null }), null);
  for (const raw of [{type:'confirmation',answer:'yes'}, {type:'question',answer:''}, {type:'question',answer:'x'.repeat(16001)}, []]) assert.equal(questionAnswer(raw), undefined);
});

test('decision choices map only explicit offered indices and escape recommendation/choice text', () => {
  const choices = ['Continue investigation','Prepare revised plan'];
  assert.equal(questionAnswer({type:'question',choice:1},choices),'Prepare revised plan');
  for(const choice of [-1,2,0.5,'0',null]) assert.equal(questionAnswer({type:'question',choice},choices),undefined);
  const html = confirmationHtml('How should Build continue?','<script>blocked</script>',choices,'fixture',true,{recommendation:'<img src=x>',options:[{label:choices[0],description:'<script>details</script>'},{label:choices[1]}],cancelLabel:'Stop run'});
  assert.ok(html.includes('Suggested next step')); assert.ok(html.includes('Give a different instruction'));
  assert.ok(html.includes('Stop run')); assert.ok(!html.includes('<img')); assert.ok(!html.includes('<script>details'));
  assert.ok(!html.includes('Send guidance'));
});
