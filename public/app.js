const COLUMNS = [
  { id: 'standby', title: 'Standby' },
  { id: 'processing', title: 'Em processamento' },
  { id: 'attention', title: 'Precisa de atenção' },
  { id: 'done', title: 'Pronto' },
];
const sessions = new Map();
const views = new Map(); // id -> { cell, term, fit, ws }
const $ = (s) => document.querySelector(s);
const termsEl = $('#terms'), kanbanEl = $('#kanban');

// ---------- metadados ----------
function connectMeta() {
  const ws = new WebSocket(`ws://${location.host}/ws/meta`);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'init') m.sessions.forEach(upsert);
    if (m.type === 'session') upsert(m.session);
    if (m.type === 'removed') remove(m.id);
    render();
  };
  ws.onclose = () => setTimeout(connectMeta, 1500);
}

function upsert(s) {
  const prev = sessions.get(s.id);
  sessions.set(s.id, s);
  if (!views.has(s.id)) createView(s);
  if (prev && prev.state !== 'attention' && s.state === 'attention') notify(s);
}
function remove(id) {
  sessions.delete(id);
  const v = views.get(id);
  if (v) { v.ws.close(); v.term.dispose(); v.cell.remove(); views.delete(id); }
}
function notify(s) {
  if (document.hasFocus() || !('Notification' in window)) return;
  if (Notification.permission === 'granted') new Notification(`${s.name} precisa de atenção`);
}

// ---------- terminais ----------
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
  cell.addEventListener('click', (ev) => { if (ev.target.dataset.a === 'max') cell.classList.toggle('max'); if (ev.target.dataset.a === 'adopt') adopt(s.id); });
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

function createView(s) {
  if (s.external) return createExtView(s);
  const cell = document.createElement('div');
  cell.className = 'cell';
  cell.innerHTML = `<div class="cell-head"><span class="dot"></span><b></b><span class="meta"></span><span class="spacer" style="flex:1"></span>
    <button data-a="max" title="Maximizar">⤢</button><button data-a="close" title="Encerrar">✕</button></div><div class="term"></div>`;
  cell.addEventListener('mousedown', () => setMain(s.id));
  termsEl.appendChild(cell);

  const term = new Terminal({ fontSize: 12, cursorBlink: true, scrollback: 5000, theme: { background: '#000' } });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(cell.querySelector('.term'));

  const ws = new WebSocket(`ws://${location.host}/ws/term/${s.id}`);
  ws.onmessage = (e) => term.write(e.data);
  term.onData((d) => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'in', d })));
  const sendSize = () => {
    try { fit.fit(); } catch { return; }
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
  };
  ws.onopen = sendSize;
  new ResizeObserver(() => requestAnimationFrame(sendSize)).observe(cell.querySelector('.term'));

  cell.addEventListener('click', (ev) => {
    const a = ev.target.dataset.a;
    if (a === 'max') { cell.classList.toggle('max'); setTimeout(sendSize, 50); }
    else if (a === 'close') {
      if (confirm(`Encerrar a sessão "${sessions.get(s.id).name}"?`)) fetch(`/api/sessions/${s.id}`, { method: 'DELETE' });
    } else term.focus();
  });
  views.set(s.id, { cell, term, fit, ws, sendSize });
}

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
    // principal = metade da largura; o resto divide a outra metade
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

// ---------- render ----------
function render() {
  const list = [...sessions.values()];
  layout();

  list.forEach((s) => {
    const v = views.get(s.id);
    v.cell.className = `cell ${s.state}${v.cell.classList.contains('max') ? ' max' : ''}`;
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

  kanbanEl.innerHTML = '';
  for (const c of COLUMNS) {
    const items = list.filter((s) => s.state === c.id).sort((a, b) => b.updatedAt - a.updatedAt);
    const col = document.createElement('div');
    col.className = 'col';
    col.innerHTML = `<h2><span class="dot ${c.id}"></span>${c.title}<span class="chip">${items.length}</span></h2><div class="list"></div>`;
    const l = col.querySelector('.list');
    if (!items.length) l.innerHTML = '<div class="empty">—</div>';
    items.forEach((s) => {
      const card = document.createElement('div');
      card.className = `card ${s.state}`;
      card.draggable = !s.external; // externas: estado é inferido, não editável
      if (s.external) card.title = `Rodando em ${s.tty} (fora do viewer). Clique para abrir aqui dentro. Estado inferido pelo transcript.`;
      card.innerHTML = `<b></b><small></small><div class="chips"></div>`;
      card.querySelector('b').textContent = s.name + (s.alive ? '' : ' (encerrada)');
      card.querySelector('small').textContent = s.cwd;
      [s.external && `externo · ${s.tty}`, s.model, s.effort && `effort: ${s.effort}`, s.permissionMode].filter(Boolean).forEach((t) => {
        const ch = document.createElement('span'); ch.className = 'chip'; ch.textContent = t;
        card.querySelector('.chips').appendChild(ch);
      });
      card.onclick = () => (s.external ? adopt(s.id) : focusSession(s.id));
      card.ondragstart = (e) => e.dataTransfer.setData('text/plain', s.id);
      l.appendChild(card);
    });
    col.ondragover = (e) => { e.preventDefault(); col.classList.add('over'); };
    col.ondragleave = () => col.classList.remove('over');
    col.ondrop = (e) => {
      e.preventDefault(); col.classList.remove('over');
      fetch(`/api/sessions/${e.dataTransfer.getData('text/plain')}/state`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: c.id }),
      });
    };
    kanbanEl.appendChild(col);
  }
  document.title = (n ? `(${n}) ` : '') + 'Claude Viewer';
}

// ---------- abas ----------
function showTab(t) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  termsEl.classList.toggle('hidden', t !== 'terms');
  kanbanEl.classList.toggle('hidden', t !== 'kanban');
  if (t === 'terms') { setTimeout(() => views.forEach((v) => v.sendSize()), 50); pollExt(); }
}
document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

// ---------- nova sessão ----------
const dlg = $('#dlg'), form = $('#form');
$('#new').onclick = () => {
  $('#err').textContent = '';
  dlg.showModal();
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
};
$('#cancel').onclick = () => dlg.close();
form.onsubmit = async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(form));
  f.continue = form.elements.continue.checked;
  if (f.modelCustom) f.model = f.modelCustom;
  delete f.modelCustom;
  const r = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) });
  if (!r.ok) { $('#err').textContent = (await r.json()).error; return; }
  const created = await r.json();
  dlg.close();
  showTab('terms');
  const t = setInterval(() => { if (views.has(created.id)) { clearInterval(t); focusSession(created.id); } }, 100);
  setTimeout(() => clearInterval(t), 3000);
};

showTab('kanban');
connectMeta();
