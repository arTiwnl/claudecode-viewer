const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { detectExternal } = require('./detect');
const { buildHooks, addHooks, removeHooks, hasHooks } = require('./lib/hooks-config');
const { nextState, mergeExternalState } = require('./lib/hook-logic');

const PORT = process.env.PORT || 7777;
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const NOTIFY = process.env.NOTIFY !== '0';
const STATES = ['standby', 'processing', 'attention', 'done'];
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS = path.join(CLAUDE_DIR, 'projects');
const GLOBAL_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const STORE_DIR = path.join(os.homedir(), '.claudecode-viewer');
const STORE = path.join(STORE_DIR, 'sessions.json');

const app = express();

// Segurança: o servidor controla terminais, então só aceita requisições vindas do próprio localhost.
// Isso bloqueia que outros sites abertos no navegador falem com a API/WebSocket (CSRF, DNS rebinding).
const allowedHosts = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const originOk = (req) => {
  if (!allowedHosts.has(req.headers.host)) return false;
  const o = req.headers.origin;
  if (!o) return true; // curl dos hooks e navegação direta não enviam Origin
  try { return allowedHosts.has(new URL(o).host); } catch { return false; }
};
app.use((req, res, next) => (originOk(req) ? next() : res.status(403).send('Forbidden')));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Acha a pasta de um pacote instalado, esteja ele em ./node_modules ou içado (npx / instalação global)
function pkgDir(name) {
  let dir = path.dirname(require.resolve(name));
  while (!fs.existsSync(path.join(dir, 'package.json')) || JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name !== name) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error(`Pacote não encontrado: ${name}`);
    dir = up;
  }
  return dir;
}
app.use('/vendor/xterm', express.static(pkgDir('@xterm/xterm')));
app.use('/vendor/fit', express.static(pkgDir('@xterm/addon-fit')));

// Hooks usados só pelas sessões abertas pelo viewer (via --settings), sem tocar na config global
const hooksFile = path.join(os.tmpdir(), `claudecode-viewer-hooks-${PORT}.json`);
fs.writeFileSync(hooksFile, JSON.stringify({ hooks: buildHooks(PORT) }));

/** @type {Map<string, any>} */
const sessions = new Map();
const externals = new Map(); // id -> view público
const extFiles = new Map(); // id -> caminho do transcript
const extMeta = new Map(); // id -> { pid, sessionId }
const hookPid = new Map(); // pid do claude externo -> estado vindo dos hooks globais
const clients = new Set();

const publicView = (s) => ({
  id: s.id, name: s.name, cwd: s.cwd, model: s.model, effort: s.effort,
  permissionMode: s.permissionMode, state: s.state, updatedAt: s.updatedAt, alive: s.alive,
  detail: s.detail || null,
});
const allViews = () => [...sessions.values()].map(publicView).concat([...externals.values()]);
const broadcast = (msg) => {
  const data = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1) c.send(data);
};

// ---------- notificação nativa do sistema ----------
const lastNotified = new Map();
function notifyNative(key, title, body) {
  if (!NOTIFY) return;
  const now = Date.now();
  if (now - (lastNotified.get(key) || 0) < 5000) return;
  lastNotified.set(key, now);
  const clean = (t) => String(t).replace(/[\r\n]+/g, ' ').slice(0, 200);
  if (process.platform === 'darwin') {
    const q = (t) => '"' + clean(t).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    execFile('osascript', ['-e', `display notification ${q(body)} with title ${q(title)} sound name "Glass"`], () => {});
  } else if (process.platform === 'linux') {
    execFile('notify-send', [clean(title), clean(body)], () => {});
  }
}
const attentionBody = (v) => (v.detail && (v.detail.tool || v.detail.message)) || 'Aguardando sua resposta';

// ---------- persistência das sessões abertas pelo viewer ----------
let saveTimer;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(STORE_DIR, { recursive: true });
      const data = [...sessions.values()].filter((s) => s.alive).map((s) => s.opts);
      fs.writeFileSync(STORE + '.tmp', JSON.stringify(data, null, 2));
      fs.renameSync(STORE + '.tmp', STORE);
    } catch (e) { console.error('persist:', e.message); }
  }, 300);
}
function transcriptExists(id) {
  try {
    for (const d of fs.readdirSync(PROJECTS)) if (fs.existsSync(path.join(PROJECTS, d, id + '.jsonl'))) return true;
  } catch {}
  return false;
}
function restoreSessions() {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return; }
  for (const o of list) {
    try {
      const resume = o.sessionId && transcriptExists(o.sessionId) ? o.sessionId : undefined;
      createSession({ ...o, resume });
    } catch (e) { console.error('restore:', o.name, e.message); }
  }
  if (list.length) console.log(`Restauradas ${list.length} sessão(ões) de ${STORE}`);
}

// ---------- estado ----------
function update(s, state, detail = null) {
  const was = s.state;
  const changed = was !== state || JSON.stringify(s.detail || null) !== JSON.stringify(detail || null);
  s.detail = detail;
  if (was !== state) { s.state = state; s.updatedAt = Date.now(); }
  if (changed) broadcast({ type: 'session', session: publicView(s) });
  if (state === 'attention' && was !== 'attention') notifyNative(s.id, `${s.name} precisa de você`, attentionBody(s));
}

function applyHook(s, state, body) {
  if (body.session_id && s.opts.sessionId !== body.session_id) {
    s.opts.sessionId = body.session_id;
    persist();
  }
  const r = nextState({ state: s.state, lastTool: s.lastTool }, state, body);
  if (!r) return;
  s.lastTool = r.lastTool;
  update(s, r.state, r.detail);
}

function applyExternalHook(pid, state, body) {
  const prev = hookPid.get(pid) || { state: 'standby', lastTool: '' };
  const r = nextState(prev, state, body);
  const h = {
    ...prev, ts: Date.now(),
    sessionId: body.session_id || prev.sessionId,
    transcript: body.transcript_path || prev.transcript,
  };
  if (r) { h.state = r.state; h.detail = r.detail; h.lastTool = r.lastTool; }
  hookPid.set(pid, h);
  pollExternal();
}

function createSession(opts) {
  const id = crypto.randomUUID().slice(0, 8);
  const cwd = (opts.cwd || os.homedir()).replace(/^~/, os.homedir());
  if (!fs.existsSync(cwd)) throw new Error(`Diretório não existe: ${cwd}`);

  const args = ['--settings', hooksFile];
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
  if (opts.addDirs) args.push('--add-dir', ...opts.addDirs.split(',').map((d) => d.trim()).filter(Boolean));
  if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt);
  if (opts.resume) args.push('--resume', opts.resume);
  if (opts.continue) args.push('--continue');
  if (opts.extraArgs) args.push(...opts.extraArgs.split(/\s+/).filter(Boolean));

  const term = pty.spawn(CLAUDE_BIN, args, {
    name: 'xterm-256color', cols: 100, rows: 30, cwd,
    env: { ...process.env, CLAUDE_VIEWER_ID: id, TERM: 'xterm-256color' },
  });

  const s = {
    id, name: opts.name || path.basename(cwd), cwd,
    model: opts.model || '', effort: opts.effort || '', permissionMode: opts.permissionMode || '',
    state: 'standby', detail: null, lastTool: '', updatedAt: Date.now(), alive: true, term, buffer: '', sockets: new Set(),
    // o que é salvo em disco para reabrir depois (sem resume/continue: o sessionId vem dos hooks)
    opts: {
      name: opts.name || path.basename(cwd), cwd, model: opts.model || '', effort: opts.effort || '',
      permissionMode: opts.permissionMode || '', addDirs: opts.addDirs || '',
      appendSystemPrompt: opts.appendSystemPrompt || '', extraArgs: opts.extraArgs || '',
      sessionId: opts.resume || '',
    },
  };
  term.onData((d) => {
    s.buffer = (s.buffer + d).slice(-200000);
    for (const ws of s.sockets) if (ws.readyState === 1) ws.send(d);
  });
  term.onExit(() => {
    s.alive = false;
    s.updatedAt = Date.now();
    broadcast({ type: 'session', session: publicView(s) });
    persist();
  });
  sessions.set(id, s);
  broadcast({ type: 'session', session: publicView(s) });
  persist();
  return s;
}

// ---------- API ----------
app.get('/api/sessions', (_, res) => res.json(allViews()));
app.get('/api/config', (_, res) => res.json({ nativeNotifications: NOTIFY && ['darwin', 'linux'].includes(process.platform) }));

app.post('/api/sessions', (req, res) => {
  try { res.json(publicView(createSession(req.body || {}))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/sessions/:id/state', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s || !STATES.includes(req.body.state)) return res.sendStatus(400);
  update(s, req.body.state, null);
  res.sendStatus(204);
});
// Aprova ou nega o pedido de permissão pendente direto do card
app.post('/api/sessions/:id/respond', (req, res) => {
  const s = sessions.get(req.params.id);
  const action = req.body && req.body.action;
  if (!s || !s.alive || !['approve', 'deny'].includes(action)) return res.sendStatus(400);
  if (s.state !== 'attention' || !s.detail || s.detail.kind !== 'permission') return res.status(409).json({ error: 'Nenhum pedido de permissão pendente.' });
  if (action === 'approve') { s.term.write('\r'); update(s, 'processing', null); }
  else { s.term.write('\x1b'); update(s, 'done', null); }
  res.sendStatus(204);
});
app.delete('/api/sessions/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.sendStatus(404);
  try { s.term.kill(); } catch {}
  sessions.delete(s.id);
  broadcast({ type: 'removed', id: s.id });
  persist();
  res.sendStatus(204);
});

// Recebe os hooks do Claude Code (o corpo é o JSON do evento). `id` = sessão do viewer ou "ext".
app.post('/hook/:id/:state', (req, res) => {
  const state = req.params.state;
  if (STATES.includes(state)) {
    const body = req.body || {};
    const s = sessions.get(req.params.id);
    if (s) applyHook(s, state, body);
    else if (req.params.id === 'ext' && /^\d+$/.test(String(req.query.ppid))) applyExternalHook(+req.query.ppid, state, body);
  }
  res.sendStatus(204);
});

// Hooks globais (opt-in): dão status exato também para sessões abertas fora do viewer
function readSettings() {
  try { return JSON.parse(fs.readFileSync(GLOBAL_SETTINGS, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error('O ~/.claude/settings.json não é um JSON válido. Não vou alterar.');
  }
}
function writeSettings(obj) {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  const bak = GLOBAL_SETTINGS + '.claudecode-viewer.bak';
  if (fs.existsSync(GLOBAL_SETTINGS) && !fs.existsSync(bak)) fs.copyFileSync(GLOBAL_SETTINGS, bak);
  fs.writeFileSync(GLOBAL_SETTINGS + '.tmp', JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(GLOBAL_SETTINGS + '.tmp', GLOBAL_SETTINGS);
}
app.get('/api/hooks', (_, res) => {
  try { res.json({ installed: hasHooks(readSettings()), path: GLOBAL_SETTINGS }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
const setGlobalHooks = (install) => (req, res) => {
  try {
    const cur = readSettings();
    writeSettings(install ? addHooks(cur, PORT) : removeHooks(cur));
    res.json({ installed: install });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
app.post('/api/hooks/install', setGlobalHooks(true));
app.post('/api/hooks/uninstall', setGlobalHooks(false));

// Conversa recente de uma sessão externa, lida do transcript
app.get('/api/external/:id/tail', (req, res) => {
  const file = extFiles.get(req.params.id);
  if (!file) return res.json({ lines: [] });
  try {
    const size = fs.statSync(file).size, len = Math.min(size, 400000);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const cut = (t, n) => (t.length > n ? t.slice(0, n) + '…' : t);
    const out = [];
    for (const line of buf.toString('utf8').split('\n')) {
      let j; try { j = JSON.parse(line); } catch { continue; }
      if ((j.type !== 'user' && j.type !== 'assistant') || !j.message || j.isSidechain) continue;
      const c = j.message.content;
      const blocks = Array.isArray(c) ? c : [{ type: 'text', text: String(c || '') }];
      for (const b of blocks) {
        if (b.type === 'text' && b.text.trim()) out.push((j.type === 'user' ? '❯ ' : '') + cut(b.text.trim(), 1500));
        else if (b.type === 'tool_use') out.push('⚙ ' + b.name + ' ' + cut(JSON.stringify(b.input || {}), 160));
        else if (b.type === 'tool_result') {
          const t = typeof b.content === 'string' ? b.content : (b.content || []).map((x) => x.text || '').join(' ');
          out.push('   ↳ ' + cut(t.replace(/\s+/g, ' ').trim(), 200));
        }
      }
    }
    res.json({ lines: out.slice(-60) });
  } catch { res.json({ lines: [] }); }
});

// Assume uma sessão externa: encerra o claude do outro terminal e retoma a mesma conversa aqui dentro
app.post('/api/external/:id/adopt', async (req, res) => {
  const e = externals.get(req.params.id), m = extMeta.get(req.params.id);
  if (!e || !m || !m.sessionId) return res.status(404).json({ error: 'Sessão externa não encontrada ou sem transcript.' });
  try {
    process.kill(m.pid, 'SIGTERM');
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { process.kill(m.pid, 0); } catch { break; }
    }
    externals.delete(req.params.id); extFiles.delete(req.params.id); extMeta.delete(req.params.id); hookPid.delete(m.pid);
    broadcast({ type: 'removed', id: req.params.id });
    const s = createSession({
      name: path.basename(e.cwd), cwd: e.cwd, model: e.model, effort: e.effort,
      permissionMode: e.permissionMode, resume: m.sessionId,
    });
    res.json(publicView(s));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const server = http.createServer(app);

// WS de metadados (kanban/lista)
const metaWss = new WebSocketServer({ noServer: true });
metaWss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'init', sessions: allViews() }));
  ws.on('close', () => clients.delete(ws));
});
// WS de terminal por sessão
const termWss = new WebSocketServer({ noServer: true });
termWss.on('connection', (ws, s) => {
  s.sockets.add(ws);
  ws.send(s.buffer);
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!s.alive) return;
    if (m.t === 'in' && typeof m.d === 'string') s.term.write(m.d);
    else if (m.t === 'resize' && m.cols > 0 && m.rows > 0) s.term.resize(m.cols, m.rows);
  });
  ws.on('close', () => s.sockets.delete(ws));
});

server.on('upgrade', (req, socket, head) => {
  if (!originOk(req)) return socket.destroy();
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/ws/meta') return metaWss.handleUpgrade(req, socket, head, (ws) => metaWss.emit('connection', ws));
  const m = url.pathname.match(/^\/ws\/term\/(\w+)$/);
  const s = m && sessions.get(m[1]);
  if (s) return termWss.handleUpgrade(req, socket, head, (ws) => termWss.emit('connection', ws, s));
  socket.destroy();
});

// ---------- detecção de sessões `claude` abertas fora do viewer ----------
let polling = false, pollAgain = false;
async function pollExternal() {
  if (polling) { pollAgain = true; return; }
  polling = true;
  try {
    const own = new Set([...sessions.values()].map((s) => s.term.pid));
    const list = await detectExternal(own, hookPid);
    const seen = new Set();
    for (const x of list) {
      const id = `ext-${x.pid}`;
      seen.add(id);
      const prev = externals.get(id);
      const merged = mergeExternalState(hookPid.get(x.pid), x.state, x.mtimeMs);
      const state = merged.state;
      const detail = merged.fromHooks ? merged.detail || null : x.detail;
      const view = {
        id, name: `${path.basename(x.cwd)} · ${x.tty}`, cwd: x.cwd, model: x.model, effort: x.effort,
        permissionMode: x.permissionMode, state, detail, alive: true, external: true, tty: x.tty,
        source: merged.fromHooks ? 'hooks' : 'transcript',
        updatedAt: prev && prev.state === state ? prev.updatedAt : Date.now(),
      };
      externals.set(id, view);
      extFiles.set(id, x.file);
      extMeta.set(id, { pid: x.pid, sessionId: x.sessionId });
      const changed = !prev || prev.state !== state || prev.model !== view.model || prev.source !== view.source ||
        JSON.stringify(prev.detail) !== JSON.stringify(detail);
      if (changed) broadcast({ type: 'session', session: view });
      if (prev && prev.state !== 'attention' && state === 'attention') notifyNative(id, `${view.name} precisa de você`, attentionBody(view));
    }
    for (const id of [...externals.keys()]) {
      if (!seen.has(id)) {
        externals.delete(id); extFiles.delete(id); extMeta.delete(id);
        broadcast({ type: 'removed', id });
      }
    }
    for (const pid of [...hookPid.keys()]) if (!seen.has(`ext-${pid}`)) hookPid.delete(pid);
  } catch (e) { console.error('detect:', e.message); }
  polling = false;
  if (pollAgain) { pollAgain = false; pollExternal(); }
}
setInterval(pollExternal, 2000);

process.on('exit', () => sessions.forEach((s) => { try { s.term.kill(); } catch {} }));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Claude Code Viewer em http://localhost:${PORT}`);
  restoreSessions();
  pollExternal();
});
