const test = require('node:test');
const assert = require('node:assert/strict');
const { addHooks, removeHooks, hasHooks, hookCommand, EVENTS, MARKER } = require('../lib/hooks-config');

const user = {
  model: 'opus',
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say pronto' }] }] },
};

test('addHooks preserva config e hooks do usuário', () => {
  const out = addHooks(user, 7777);
  assert.equal(out.model, 'opus');
  assert.equal(out.hooks.Stop.length, 2);
  assert.equal(out.hooks.Stop[0].hooks[0].command, 'say pronto');
  for (const e of Object.keys(EVENTS)) assert.ok(out.hooks[e], e);
  assert.ok(hasHooks(out));
  assert.equal(hasHooks(user), false);
});

test('addHooks não muta a entrada e é idempotente', () => {
  const snapshot = JSON.stringify(user);
  const once = addHooks(user, 7777);
  assert.equal(JSON.stringify(user), snapshot);
  assert.equal(JSON.stringify(addHooks(once, 7777)), JSON.stringify(once));
});

test('removeHooks devolve exatamente a config original', () => {
  assert.deepEqual(removeHooks(addHooks(user, 7777)), user);
  assert.deepEqual(removeHooks(addHooks({}, 7777)), {});
});

test('comando do hook é seguro e identificável', () => {
  const c = hookCommand(7777, 'attention');
  assert.ok(c.includes(MARKER));
  assert.ok(c.includes('127.0.0.1:7777'));
  assert.ok(c.includes('|| true'), 'não pode quebrar o claude com o viewer fechado');
  assert.ok(c.includes('$PPID'));
});
