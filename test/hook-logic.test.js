const test = require('node:test');
const assert = require('node:assert/strict');
const { nextState, mergeExternalState } = require('../lib/hook-logic');
const { describeTool } = require('../lib/describe');

test('describeTool resume comando, arquivo e fallback', () => {
  assert.equal(describeTool('Bash', { command: 'npm   test\n' }), 'Bash: npm test');
  assert.equal(describeTool('Edit', { file_path: '/a/b.js' }), 'Edit: /a/b.js');
  assert.equal(describeTool('X', { foo: 1 }), 'X: {"foo":1}');
  assert.equal(describeTool('Bash', { command: 'x'.repeat(500) }).length, 'Bash: '.length + 200);
});

test('PreToolUse guarda a última ferramenta e segue em processamento', () => {
  const r = nextState({ state: 'standby', lastTool: '' }, 'processing', {
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf dist' },
  });
  assert.equal(r.state, 'processing');
  assert.equal(r.lastTool, 'Bash: rm -rf dist');
  assert.equal(r.detail, null);
});

test('Notification de permissão vira atenção com a ferramenta pendente', () => {
  const r = nextState({ state: 'processing', lastTool: 'Bash: rm -rf dist' }, 'attention', {
    message: 'Claude needs your permission to use Bash',
  });
  assert.equal(r.state, 'attention');
  assert.equal(r.detail.kind, 'permission');
  assert.equal(r.detail.tool, 'Bash: rm -rf dist');
});

test('notification_type tem prioridade sobre o texto', () => {
  const r = nextState({ state: 'processing', lastTool: '' }, 'attention', { notification_type: 'permission_prompt', message: 'x' });
  assert.equal(r.detail.kind, 'permission');
});

test('aviso de ociosidade depois de terminar é ignorado', () => {
  for (const state of ['done', 'standby']) {
    assert.equal(nextState({ state, lastTool: '' }, 'attention', { message: 'Claude is waiting for your input' }), null);
  }
});

test('aviso de ociosidade durante o trabalho ainda chama atenção', () => {
  const r = nextState({ state: 'processing', lastTool: '' }, 'attention', { notification_type: 'idle_prompt' });
  assert.equal(r.state, 'attention');
  assert.equal(r.detail.kind, 'idle');
});

test('Stop guarda a última mensagem e zera a ferramenta', () => {
  const r = nextState({ state: 'processing', lastTool: 'Bash: x' }, 'done', { last_assistant_message: '  pronto!  ' });
  assert.deepEqual(r, { state: 'done', detail: { kind: 'done', message: 'pronto!' }, lastTool: '' });
});

test('mergeExternalState: hooks mandam, com exceções', () => {
  const now = 1_000_000;
  assert.deepEqual(mergeExternalState(undefined, 'done', 0, now), { state: 'done', fromHooks: false });
  const h = { state: 'attention', detail: { kind: 'permission' }, ts: now - 10_000 };
  assert.equal(mergeExternalState(h, 'done', 0, now).fromHooks, true);
  // transcript andou depois do pedido (ex.: respondeu com Esc): confia na inferência
  assert.equal(mergeExternalState(h, 'processing', now - 1000, now).state, 'processing');
  // "processando" velho e transcript parado: foi interrompido
  const p = { state: 'processing', ts: now - 120_000 };
  assert.equal(mergeExternalState(p, 'standby', 0, now).state, 'standby');
  assert.equal(mergeExternalState({ ...p, ts: now - 5000 }, 'standby', 0, now).state, 'processing');
});
