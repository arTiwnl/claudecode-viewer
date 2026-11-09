const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { detectExternal } = require('./detect');

const PORT = process.env.PORT || 7777;
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const STATES = ['standby', 'processing', 'attention', 'done'];

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
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/vendor/fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));

// Hooks do Claude Code: avisam o viewer quando o estado muda (por sessão, via env CLAUDE_VIEWER_ID)
const hookCmd = (state) =>
  `curl -s -m 2 -X POST "http://127.0.0.1:${PORT}/hook/$CLAUDE_VIEWER_ID/${state}" >/dev/null 2>&1 || true`;
const hook = (state) => [{ hooks: [{ type: 'command', command: hookCmd(state) }] }];
const hooksFile = path.join(os.tmpdir(), `claude-viewer-hooks-${PORT}.json`);
fs.writeFileSync(
  hooksFile,
  JSON.stringify({
    hooks: {
      UserPromptSubmit: hook('processing'),
      PreToolUse: hook('processing'),
      Notification: hook('attention'),
      Stop: hook('done'),
      SessionStart: hook('standby'),
    },
  })
);

/** @type {Map<string, any>} */
const sessions = new Map();
const clients = new Set();

const publicView = (s) => ({
  id: s.id, name: s.name, cwd: s.cwd, model: s.model, effort: s.effort,
  permissionMode: s.permissionMode, state: s.state, updatedAt: s.updatedAt, alive: s.alive,
});
const broadcast = (msg) => {
  const data = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1) c.send(data);
};
const setState = (s, state) => {
  if (s.state === state) return;
  s.state = state;
  s.updatedAt = Date.now();
  broadcast({ type: 'session', session: publicView(s) });
};

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
    state: 'standby', updatedAt: Date.now(), alive: true, term, buffer: '', sockets: new Set(),
  };
  term.onData((d) => {
    s.buffer = (s.buffer + d).slice(-200000);
    for (const ws of s.sockets) if (ws.readyState === 1) ws.send(d);
  });
  term.onExit(() => {
    s.alive = false;
    s.updatedAt = Date.now();
    broadcast({ type: 'session', session: publicView(s) });
  });
  sessions.set(id, s);
  broadcast({ type: 'session', session: publicView(s) });
  return s;
}

app.get('/api/sessions', (_, res) => res.json([...sessions.values()].map(publicView).concat([...externals.values()])));
app.post('/api/sessions', (req, res) => {
  try { res.json(publicView(createSession(req.body || {}))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/sessions/:id/state', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s || !STATES.includes(req.body.state)) return res.sendStatus(400);
  setState(s, req.body.state);
  res.sendStatus(204);
});
app.delete('/api/sessions/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.sendStatus(404);
  try { s.term.kill(); } catch {}
  sessions.delete(s.id);
  broadcast({ type: 'removed', id: s.id });
  res.sendStatus(204);
});
app.post('/hook/:id/:state', (req, res) => {
  const s = sessions.get(req.params.id);
  if (s && STATES.includes(req.params.state)) {
    // PreToolUse só vale se estava em "attention" (usuário aprovou) ou standby/done
    setState(s, req.params.state);
  }
  res.sendStatus(204);
});

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
    externals.delete(req.params.id); extFiles.delete(req.params.id); extMeta.delete(req.params.id);
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
  ws.send(JSON.stringify({ type: 'init', sessions: [...sessions.values()].map(publicView).concat([...externals.values()]) }));
  ws.on('close', () => clients.delete(ws));
});
// WS de terminal por sessão
const termWss = new WebSocketServer({ noServer: true });
termWss.on('connection', (ws, s) => {
  s.sockets.add(ws);
  ws.send(s.buffer);
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (!s.alive) return;
    if (m.t === 'in') s.term.write(m.d);
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

// ---- Detecção de sessões `claude` abertas fora do viewer (outros terminais) ----
const externals = new Map();
const extFiles = new Map();
const extMeta = new Map();
async function pollExternal() {
  try {
    const own = new Set([...sessions.values()].map((s) => s.term.pid));
    const list = await detectExternal(own);
    const seen = new Set();
    for (const x of list) {
      const id = `ext-${x.pid}`;
      seen.add(id);
      const prev = externals.get(id);
      const view = {
        id, name: `${path.basename(x.cwd)} · ${x.tty}`, cwd: x.cwd, model: x.model, effort: x.effort,
        permissionMode: x.permissionMode, state: x.state, alive: true, external: true, tty: x.tty,
        updatedAt: prev && prev.state === x.state ? prev.updatedAt : Date.now(),
      };
      externals.set(id, view);
      extFiles.set(id, x.file);
      extMeta.set(id, { pid: x.pid, sessionId: x.sessionId });
      if (!prev || prev.state !== view.state || prev.model !== view.model) broadcast({ type: 'session', session: view });
    }
    for (const id of [...externals.keys()]) {
      if (!seen.has(id)) { externals.delete(id); extFiles.delete(id); extMeta.delete(id); broadcast({ type: 'removed', id }); }
    }
  } catch (e) { console.error('detect:', e.message); }
}
setInterval(pollExternal, 2000);
pollExternal();

process.on('exit', () => sessions.forEach((s) => { try { s.term.kill(); } catch {} }));
process.on('SIGINT', () => process.exit(0));
server.listen(PORT, '127.0.0.1', () => console.log(`Claude Viewer em http://localhost:${PORT}`));
