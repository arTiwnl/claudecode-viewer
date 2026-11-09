const COLUMNS = [
  { id: 'standby', title: 'Standby' },
  { id: 'processing', title: 'Em processamento' },
  { id: 'attention', title: 'Precisa de atenção' },
  { id: 'done', title: 'Pronto' },
];
const AGE_LABEL = { standby: 'parado há', processing: 'processando há', attention: 'esperando você há', done: 'pronto há' };

const sessions = new Map();
const views = new Map(); // id -> { cell, term, fit, ws, ... }
const $ = (s) => document.querySelector(s);
const termsEl = $('#terms'), kanbanEl = $('#kanban');
let nativeNotifications = false;

const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const wsUrl = (p) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${p}`;

function formatAge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return 'menos de 1 min';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

// ---------- metadados (com reconexão) ----------
function connectMeta() {
  const ws = new WebSocket(wsUrl('/ws/meta'));
  ws.onopen = () => ($('#conn').hidden = true);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'init') {
      // descarta o que sumiu enquanto estávamos desconectados
      const alive = new Set(m.sessions.map((s) => s.id));
      [...sessions.keys()].filter((id) => !alive.has(id)).forEach(remove);
      m.sessions.forEach(upsert);
    }
    if (m.type === 'session') upsert(m.session);
    if (m.type === 'removed') remove(m.id);
    render();
  };
  ws.onclose = () => { $('#conn').hidden = false; setTimeout(connectMeta, 1500); };
}

function upsert(s) {
  const prev = sessions.get(s.id);
  sessions.set(s.id, s);
  if (!views.has(s.id)) createView(s);
  if (!nativeNotifications && prev && prev.state !== 'attention' && s.state === 'attention') notify(s);
}
function remove(id) {
  sessions.delete(id);
  const v = views.get(id);
  if (v) { v.closed = true; v.ws.close(); v.term.dispose(); v.cell.remove(); views.delete(id); }
}
// só usado quando o sistema não tem notificação nativa (o servidor cuida disso no macOS/Linux)
function notify(s) {
  if (document.hasFocus() || !('Notification' in window)) return;
  if (Notification.permission === 'granted') new Notification(`${s.name} precisa de atenção`, { body: (s.detail && s.detail.tool) || '' });
}

// ---------- sessões externas ----------
async function adopt(id) {
  const s = sessions.get(id);
  if (!confirm(`Abrir "${s.name}" aqui dentro?\n\nIsso ENCERRA o claude que está rodando em ${s.tty} e retoma a mesma conversa (--resume) neste app. ` +
    `O terminal original volta para o shell. Se ele estiver no meio de uma tarefa, ela será interrompida.` +
    (s.state === 'processing' ? '\n\n⚠ Esta sessão está EM PROCESSAMENTO agora.' : ''))) return;
  const r = await fetch(`/api/external/${id}/adopt`, { method: 'POST' });
  const j = await r.json();
  if (!r.ok) return alert(j.error);
  remove(id);
  upsert(j);
  render();
  focusSession(j.id);
}

function createExtView(s) {
  const cell = document.createElement('div');
  cell.className = 'cell';
  cell.innerHTML = `<div class="cell-head"><span class="dot"></span><b></b><span class="meta"></span><span class="spacer" style="flex:1"></span>
    <span class="chip">somente leitura</span><button data-a="adopt" title="Abrir terminal interativo aqui">Abrir aqui</button><button data-a="max" title="Maximizar">⤢</button></div><pre class="log"></pre>`;
  cell.addEventListener('click', (ev) => {
    if (ev.target.dataset.a === 'max') cell.classList.toggle('max');
    if (ev.target.dataset.a === 'adopt') adopt(s.id);
  });
  cell.addEventListener('mousedown', () => setMain(s.id));
  termsEl.appendChild(cell);
  views.set(s.id, { cell, ext: true, sendSize() {}, term: { dispose() {}, focus() {} }, ws: { close() {} } });
}
async function pollExt() {
  if (termsEl.classList.contains('hidden')) return;
  for (const [id, v] of views) {
    if (!v.ext) continue;
    try {
      const { lines } = await (await fetch(`/api/external/${id}/tail`)).json();
      const txt = lines.join('\n\n');
      const log = v.cell.querySelector('.log');
      if (txt === v.last) continue;
      v.last = txt;
      const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 40;
      log.textContent = txt;
      if (stick) log.scrollTop = log.scrollHeight;
    } catch {}
  }
}
setInterval(pollExt, 2500);

// ---------- terminais (com reconexão) ----------
function createView(s) {
  if (s.external) return createExtView(s);
  const cell = document.createElement('div');
  cell.className = 'cell';
  cell.innerHTML = `<div class="cell-head"><span class="dot"></span><b></b><span class="meta"></span><span class="spacer" style="flex:1"></span>
    <span class="chip offline-chip" hidden>reconectando…</span>
    <button data-a="max" title="Maximizar">⤢</button><button data-a="close" title="Encerrar">✕</button></div><div class="term"></div>`;
  cell.addEventListener('mousedown', () => setMain(s.id));
  termsEl.appendChild(cell);

  const term = new Terminal({ fontSize: 12, cursorBlink: true, scrollback: 5000, theme: { background: '#000' } });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(cell.querySelector('.term'));

  const view = { cell, term, fit, ws: null, closed: false, retry: 0 };
  const chip = cell.querySelector('.offline-chip');

  const sendSize = () => {
    try { fit.fit(); } catch { return; }
    if (view.ws && view.ws.readyState === 1) view.ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
  };
  function connect() {
    const ws = new WebSocket(wsUrl(`/ws/term/${s.id}`));
    view.ws = ws;
    ws.onopen = () => {
      view.retry = 0;
      chip.hidden = true;
      term.reset(); // o servidor reenvia o histórico recente ao conectar
      sendSize();
    };
    ws.onmessage = (e) => term.write(e.data);
    ws.onclose = () => {
      if (view.closed || !sessions.has(s.id)) return;
      chip.hidden = false;
      view.retry = Math.min(view.retry + 1, 6);
      setTimeout(() => !view.closed && connect(), 500 * view.retry);
    };
  }
  term.onData((d) => view.ws && view.ws.readyState === 1 && view.ws.send(JSON.stringify({ t: 'in', d })));
  new ResizeObserver(() => requestAnimationFrame(sendSize)).observe(cell.querySelector('.term'));
  connect();

  cell.addEventListener('click', (ev) => {
    const a = ev.target.dataset.a;
    if (a === 'max') { cell.classList.toggle('max'); setTimeout(sendSize, 50); }
    else if (a === 'close') {
      if (confirm(`Encerrar a sessão "${sessions.get(s.id).name}"?`)) fetch(`/api/sessions/${s.id}`, { method: 'DELETE' });
    } else term.focus();
  });
  view.sendSize = sendSize;
  views.set(s.id, view);
}

// ---------- layout: principal à esquerda, demais empilhados à direita ----------
let mainId = null;
function setMain(id) {
  if (mainId === id) return;
  mainId = id;
  layout();
}
function layout() {
  const ids = [...views.keys()];
  if (!ids.length) return;
  if (!views.has(mainId)) mainId = ids[0];
  const others = ids.filter((i) => i !== mainId);
  const rc = others.length > 4 ? 2 : 1; // colunas à direita
  const rows = Math.max(Math.ceil(others.length / rc), 1);
  if (!others.length) {
    termsEl.style.gridTemplateColumns = 'minmax(0,1fr)';
    termsEl.style.gridTemplateRows = 'minmax(0,1fr)';
  } else {
    termsEl.style.gridTemplateColumns = `minmax(0,${rc}fr) repeat(${rc}, minmax(0,1fr))`;
    termsEl.style.gridTemplateRows = `repeat(${rows}, minmax(0,1fr))`;
  }
  const main = views.get(mainId).cell;
  main.style.gridColumn = '1';
  main.style.gridRow = others.length ? `1 / span ${rows}` : '1';
  others.forEach((id, i) => {
    const c = views.get(id).cell;
    c.style.gridColumn = String(2 + (i % rc));
    c.style.gridRow = String(1 + Math.floor(i / rc));
  });
  views.forEach((v, k) => v.cell.classList.toggle('is-main', k === mainId));
}

function focusSession(id) {
  showTab('terms');
  if (!views.has(id)) return;
  views.forEach((v) => v.cell.classList.remove('max'));
  mainId = id;
  layout();
  const v = views.get(id);
  setTimeout(() => { v.sendSize(); v.term.focus(); }, 80);
}

// ---------- kanban ----------
function buildCard(s) {
  const card = document.createElement('div');
  card.className = `card ${s.state}`;
  card.draggable = !s.external; // externas: estado é inferido, não editável
  if (s.external) card.title = `Rodando em ${s.tty} (fora do viewer). Clique para abrir aqui dentro.`;
  card.innerHTML = `<b></b><small></small><div class="detail" hidden></div><div class="actions-row" hidden></div><div class="chips"></div><div class="age"></div>`;
  card.querySelector('b').textContent = s.name + (s.alive ? '' : ' (encerrada)');
  card.querySelector('small').textContent = s.cwd;

  // 3) o que o card está esperando / o que foi entregue
  const d = s.detail;
  if (d && (d.tool || d.message)) {
    const el = card.querySelector('.detail');
    el.hidden = false;
    el.className = `detail ${d.kind || ''}`;
    el.textContent = d.kind === 'permission' || d.kind === 'other' || d.kind === 'idle'
      ? [d.message, d.tool].filter(Boolean).join('\n')
      : d.message;
  }
  // aprovar / negar direto do card (só sessões abertas aqui, com pedido de permissão)
  if (!s.external && s.alive && s.state === 'attention' && d && d.kind === 'permission') {
    const row = card.querySelector('.actions-row');
    row.hidden = false;
    for (const [action, label, cls] of [['approve', '✔ Aprovar', 'ok'], ['deny', '✘ Negar', 'no']]) {
      const b = document.createElement('button');
      b.textContent = label; b.className = cls;
      b.onclick = (ev) => { ev.stopPropagation(); fetch(`/api/sessions/${s.id}/respond`, json('POST', { action })); };
      row.appendChild(b);
    }
  }
  [s.external && `externo · ${s.tty}`, s.external && (s.source === 'hooks' ? 'status exato' : 'status estimado'),
    s.model, s.effort && `effort: ${s.effort}`, s.permissionMode].filter(Boolean).forEach((t) => {
    const ch = document.createElement('span'); ch.className = 'chip'; ch.textContent = t;
    card.querySelector('.chips').appendChild(ch);
  });
  // 4) tempo na coluna
  const age = card.querySelector('.age');
  age.dataset.ts = s.updatedAt; age.dataset.state = s.state;
  age.textContent = `${AGE_LABEL[s.state]} ${formatAge(Date.now() - s.updatedAt)}`;

  card.onclick = () => (s.external ? adopt(s.id) : focusSession(s.id));
  card.ondragstart = (e) => e.dataTransfer.setData('text/plain', s.id);
  return card;
}
function refreshAges() {
  document.querySelectorAll('.age').forEach((el) => {
    el.textContent = `${AGE_LABEL[el.dataset.state]} ${formatAge(Date.now() - Number(el.dataset.ts))}`;
  });
}
setInterval(refreshAges, 15000);

let lastSig = '';
function render() {
  const list = [...sessions.values()];
  layout();

  list.forEach((s) => {
    const v = views.get(s.id);
    if (!v) return;
    v.cell.className = `cell ${s.state}${v.cell.classList.contains('max') ? ' max' : ''}${v.cell.classList.contains('is-main') ? ' is-main' : ''}`;
    v.cell.querySelector('.dot').className = `dot ${s.state}`;
    v.cell.querySelector('b').textContent = s.name + (s.alive ? '' : ' (encerrada)');
    v.cell.querySelector('.meta').textContent = [s.model, s.effort && `effort:${s.effort}`].filter(Boolean).join(' · ');
  });

  let hint = $('#hint');
  if (!hint) {
    hint = document.createElement('div');
    hint.id = 'hint';
    hint.className = 'empty';
    hint.style.cssText = 'grid-column:1/-1;align-self:center';
    hint.innerHTML = 'Nenhum terminal aberto aqui ainda.<br>Clique em <b>+ Nova sessão</b> para abrir um Claude dentro do app.<br>As sessões já rodando no seu Mac aparecem na aba <b>Kanban</b>.';
    termsEl.prepend(hint);
  }
  hint.hidden = views.size > 0;

  const n = list.filter((s) => s.state === 'attention').length;
  const badge = $('#attn');
  badge.hidden = !n; badge.textContent = n;
  document.title = (n ? `(${n}) ` : '') + 'Claude Code Viewer';

  // só reconstrói o Kanban quando algo visível mudou (evita perder cliques/arrasto)
  const sig = JSON.stringify(list.map((s) => [s.id, s.state, s.updatedAt, s.detail, s.name, s.model, s.alive, s.source]));
  if (sig === lastSig) return;
  lastSig = sig;

  kanbanEl.innerHTML = '';
  for (const c of COLUMNS) {
    // 4) quem espera há mais tempo aparece primeiro em "Precisa de atenção"
    const items = list.filter((s) => s.state === c.id)
      .sort((a, b) => (c.id === 'attention' ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt));
    const col = document.createElement('div');
    col.className = 'col';
    col.innerHTML = `<h2><span class="dot ${c.id}"></span>${c.title}<span class="chip">${items.length}</span></h2><div class="list"></div>`;
    const l = col.querySelector('.list');
    if (!items.length) l.innerHTML = '<div class="empty">—</div>';
    items.forEach((s) => l.appendChild(buildCard(s)));
    col.ondragover = (e) => { e.preventDefault(); col.classList.add('over'); };
    col.ondragleave = () => col.classList.remove('over');
    col.ondrop = (e) => {
      e.preventDefault(); col.classList.remove('over');
      fetch(`/api/sessions/${e.dataTransfer.getData('text/plain')}/state`, json('POST', { state: c.id }));
    };
    kanbanEl.appendChild(col);
  }
}

// ---------- abas ----------
function showTab(t) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  termsEl.classList.toggle('hidden', t !== 'terms');
  kanbanEl.classList.toggle('hidden', t !== 'kanban');
  if (t === 'terms') { setTimeout(() => views.forEach((v) => v.sendSize()), 50); pollExt(); }
}
document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

// ---------- status exato (hooks globais, opt-in) ----------
const hooksBtn = $('#hooks');
let hooksInstalled = false;
function paintHooksBtn() {
  hooksBtn.textContent = hooksInstalled ? 'Status exato: ligado ✓' : 'Ligar status exato';
  hooksBtn.title = hooksInstalled
    ? 'Hooks do viewer instalados em ~/.claude/settings.json. Clique para remover.'
    : 'Instala hooks em ~/.claude/settings.json para dar status exato às sessões abertas em outros terminais.';
}
async function loadHooks() {
  try { hooksInstalled = (await (await fetch('/api/hooks')).json()).installed; } catch {}
  paintHooksBtn();
}
hooksBtn.onclick = async () => {
  const msg = hooksInstalled
    ? 'Remover os hooks do viewer de ~/.claude/settings.json?\n\nSeus outros hooks não são tocados.'
    : 'Instalar os hooks do viewer em ~/.claude/settings.json?\n\n' +
      '• Dá status EXATO (em vez de estimado) para sessões abertas em outros terminais.\n' +
      '• Vale só para sessões que você abrir/reiniciar DEPOIS disso.\n' +
      '• É feito um backup (settings.json.claudecode-viewer.bak) e seus hooks atuais são preservados.\n' +
      '• Com o viewer fechado, os hooks não fazem nada.\n\nVocê pode remover quando quiser por este mesmo botão.';
  if (!confirm(msg)) return;
  const r = await fetch(`/api/hooks/${hooksInstalled ? 'uninstall' : 'install'}`, { method: 'POST' });
  const j = await r.json();
  if (!r.ok) return alert(j.error);
  hooksInstalled = j.installed;
  paintHooksBtn();
};

// ---------- nova sessão ----------
const dlg = $('#dlg'), form = $('#form');
$('#new').onclick = () => {
  $('#err').textContent = '';
  dlg.showModal();
  if (!nativeNotifications && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
};
$('#cancel').onclick = () => dlg.close();
form.onsubmit = async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(form));
  f.continue = form.elements.continue.checked;
  if (f.modelCustom) f.model = f.modelCustom;
  delete f.modelCustom;
  const r = await fetch('/api/sessions', json('POST', f));
  if (!r.ok) { $('#err').textContent = (await r.json()).error; return; }
  const created = await r.json();
  dlg.close();
  showTab('terms');
  const t = setInterval(() => { if (views.has(created.id)) { clearInterval(t); focusSession(created.id); } }, 100);
  setTimeout(() => clearInterval(t), 3000);
};

showTab('kanban');
fetch('/api/config').then((r) => r.json()).then((c) => (nativeNotifications = c.nativeNotifications)).catch(() => {});
loadHooks();
connectMeta();
