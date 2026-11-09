const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inferState } = require('../detect');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-detect-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const line = (o) => JSON.stringify(o);
const asst = (content, extra = {}) => line({ type: 'assistant', message: { model: 'claude-sonnet-5-5', content }, ...extra });
const user = (content) => line({ type: 'user', message: { content } });

function transcript(name, lines, ageSeconds) {
  const f = path.join(dir, name + '.jsonl');
  fs.writeFileSync(f, lines.join('\n') + '\n');
  const t = new Date(Date.now() - ageSeconds * 1000);
  fs.utimesSync(f, t, t);
  return f;
}

test('resposta final antiga = pronto, com o texto', () => {
  const r = inferState(transcript('a', [user('oi'), asst([{ type: 'text', text: 'feito!' }])], 60));
  assert.equal(r.state, 'done');
  assert.equal(r.detail.message, 'feito!');
  assert.equal(r.model, 'claude-sonnet-5-5');
});

test('resposta que acabou de chegar = ainda processando', () => {
  assert.equal(inferState(transcript('b', [asst([{ type: 'text', text: 'x' }])], 1)).state, 'processing');
});

test('ferramenta pedida e parada = precisa de atenção, com a ferramenta', () => {
  const r = inferState(transcript('c', [asst([{ type: 'tool_use', name: 'Bash', input: { command: 'rm -rf dist' } }])], 30));
  assert.equal(r.state, 'attention');
  assert.equal(r.detail.tool, 'Bash: rm -rf dist');
});

test('ferramenta pedida agora = processando (ainda não é pedido de permissão)', () => {
  assert.equal(inferState(transcript('d', [asst([{ type: 'tool_use', name: 'Bash', input: {} }])], 2)).state, 'processing');
});

test('último é do usuário: processando; muito antigo vira standby', () => {
  assert.equal(inferState(transcript('e', [user('faz isso')], 20)).state, 'processing');
  assert.equal(inferState(transcript('f', [user('faz isso')], 600)).state, 'standby');
});

test('mensagens de subagente (sidechain) são ignoradas', () => {
  const r = inferState(transcript('g', [
    asst([{ type: 'text', text: 'final' }]),
    asst([{ type: 'tool_use', name: 'Bash', input: {} }], { isSidechain: true }),
  ], 60));
  assert.equal(r.state, 'done');
});

test('arquivo vazio, lixo ou inexistente = standby', () => {
  assert.equal(inferState(transcript('h', ['{quebrado', ''], 60)).state, 'standby');
  assert.equal(inferState(path.join(dir, 'nao-existe.jsonl')).state, 'standby');
});
