// Integração: sobe o servidor de verdade com um "claude" falso e um HOME temporário.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 20000 + Math.floor(Math.random() * 20000);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-home-'));
const FAKE = path.join(__dirname, 'fixtures', 'fake-claude');
let proc;

function req(method, url, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      { host: '127.0.0.1', port: PORT, path: url, method, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers } },
      (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(t); } catch { return null; } })() })); }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(80); }
  throw new Error('timeout');
}
function start() {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOME, NOTIFY: '0', CLAUDE_BIN: FAKE }, stdio: 'pipe',
  });
  return new Promise((res, rej) => {
    proc.stdout.on('data', (d) => d.toString().includes('em http') && res());
    proc.on('error', rej);
  });
}
const stop = () => new Promise((r) => { proc.once('exit', r); proc.kill('SIGTERM'); });

test.before(start);
test.after(async () => { await stop(); fs.rmSync(HOME, { recursive: true, force: true }); });

test('bloqueia origem estranha e Host forjado (CSRF / DNS rebinding)', async () => {
  assert.equal((await req('GET', '/api/sessions')).status, 200);
  assert.equal((await req('POST', '/api/sessions', { body: { cwd: HOME }, headers: { Origin: 'https://evil.com' } })).status, 403);
  assert.equal((await req('GET', '/api/sessions', { headers: { Host: 'evil.com:' + PORT } })).status, 403);
});

let sid;
test('hooks levam a sessão por processando -> atenção -> aprovar', async () => {
  const created = (await req('POST', '/api/sessions', { body: { name: 't1', cwd: HOME } })).json;
  sid = created.id;
  assert.equal(created.state, 'standby');

  const hook = (state, body) => req('POST', `/hook/${sid}/${state}?ppid=1`, { body });
  const get = async () => (await req('GET', '/api/sessions')).json.find((s) => s.id === sid);

  await hook('processing', { hook_event_name: 'PreToolUse', session_id: 'sess-1', tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } });
  assert.equal((await get()).state, 'processing');

  await hook('attention', { hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' });
  const s = await get();
  assert.equal(s.state, 'attention');
  assert.equal(s.detail.kind, 'permission');
  assert.equal(s.detail.tool, 'Bash: rm -rf dist');

  assert.equal((await req('POST', `/api/sessions/${sid}/respond`, { body: { action: 'approve' } })).status, 204);
  assert.equal((await get()).state, 'processing');
  // sem pedido pendente, responder é recusado
  assert.equal((await req('POST', `/api/sessions/${sid}/respond`, { body: { action: 'approve' } })).status, 409);

  await hook('done', { hook_event_name: 'Stop', last_assistant_message: 'tudo certo' });
  const d = await get();
  assert.equal(d.state, 'done');
  assert.equal(d.detail.message, 'tudo certo');
  // aviso de "esperando input" depois de terminar não reabre atenção
  await hook('attention', { notification_type: 'idle_prompt' });
  assert.equal((await get()).state, 'done');
});

test('a sessão é salva e restaurada após reiniciar o servidor', async () => {
  const store = path.join(HOME, '.claudecode-viewer', 'sessions.json');
  const saved = await until(() => { try { const j = JSON.parse(fs.readFileSync(store, 'utf8')); return j.length ? j : null; } catch { return null; } });
  assert.equal(saved[0].name, 't1');
  assert.equal(saved[0].sessionId, 'sess-1'); // veio do payload do hook

  await stop();
  await start();
  const list = await until(async () => { const l = (await req('GET', '/api/sessions')).json; return l.some((s) => s.name === 't1') ? l : null; });
  assert.equal(list.filter((s) => s.name === 't1').length, 1);
});

test('encerrar a sessão a remove da persistência', async () => {
  const s = (await req('GET', '/api/sessions')).json.find((x) => x.name === 't1');
  assert.equal((await req('DELETE', `/api/sessions/${s.id}`)).status, 204);
  const store = path.join(HOME, '.claudecode-viewer', 'sessions.json');
  await until(() => JSON.parse(fs.readFileSync(store, 'utf8')).length === 0);
});
