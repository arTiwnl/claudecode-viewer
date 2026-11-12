// Modo remoto: token obrigatório para quem não é o próprio localhost.
// Simulamos "outra máquina" falando pelo loopback com um Host diferente de localhost.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const PORT = 20000 + Math.floor(Math.random() * 20000);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-remote-'));
const TOKEN = 'tok-' + 'x'.repeat(40);
const REMOTE_HOST = `nas.local:${PORT}`;
let proc;

function req(url, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: url, method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    r.on('error', reject);
    r.end();
  });
}
const remote = (url, headers = {}) => req(url, { headers: { Host: REMOTE_HOST, ...headers } });
const cookie = { Cookie: `cv_token=${TOKEN}` };

function wsOutcome(headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/meta`, { headers });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('error', () => resolve('rejected'));
    ws.on('unexpected-response', () => resolve('rejected'));
  });
}

test.before(() => new Promise((res, rej) => {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOME, NOTIFY: '0', REMOTE: '1', HOST: '127.0.0.1', CLAUDE_VIEWER_TOKEN: TOKEN },
    stdio: 'pipe',
  });
  proc.stdout.on('data', (d) => d.toString().includes('MODO REMOTO') && res());
  proc.on('error', rej);
}));
test.after(() => new Promise((r) => { proc.once('exit', () => { fs.rmSync(HOME, { recursive: true, force: true }); r(); }); proc.kill('SIGTERM'); }));

test('de fora, sem token ou com token errado: 401', async () => {
  assert.equal((await remote('/api/sessions')).status, 401);
  assert.equal((await remote('/?token=errado')).status, 401);
  assert.equal((await remote('/api/sessions', { Cookie: 'cv_token=errado' })).status, 401);
  assert.equal((await remote('/api/sessions', { Authorization: 'Bearer errado' })).status, 401);
});

test('link com ?token= grava cookie HttpOnly e limpa a URL', async () => {
  const r = await remote(`/?token=${TOKEN}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/');
  const c = r.headers['set-cookie'][0];
  assert.match(c, new RegExp(`cv_token=${TOKEN}`));
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
});

test('com cookie ou Bearer certo: acesso liberado', async () => {
  assert.equal((await remote('/api/sessions', cookie)).status, 200);
  assert.equal((await remote('/api/sessions', { Authorization: `Bearer ${TOKEN}` })).status, 200);
  assert.equal((await remote('/', cookie)).status, 200);
});

test('com token, mas Origin de outro site: 403 (CSRF)', async () => {
  assert.equal((await remote('/api/sessions', { ...cookie, Origin: 'https://evil.com' })).status, 403);
  assert.equal((await remote('/api/sessions', { ...cookie, Origin: `http://${REMOTE_HOST}` })).status, 200);
});

test('acesso local continua sem token', async () => {
  assert.equal((await req('/api/sessions', { headers: { Host: `127.0.0.1:${PORT}` } })).status, 200);
  assert.equal((await req('/api/sessions', { headers: { Host: `localhost:${PORT}` } })).status, 200);
});

test('hooks de fora não passam sem token', async () => {
  assert.equal((await req('/hook/ext/attention?ppid=1', { method: 'POST', headers: { Host: REMOTE_HOST } })).status, 401);
});

test('WebSocket de fora exige o cookie', async () => {
  assert.equal(await wsOutcome({ Host: REMOTE_HOST }), 'rejected');
  assert.equal(await wsOutcome({ Host: REMOTE_HOST, ...cookie }), 'open');
  assert.equal(await wsOutcome({ Host: REMOTE_HOST, ...cookie, Origin: 'https://evil.com' }), 'rejected');
});
