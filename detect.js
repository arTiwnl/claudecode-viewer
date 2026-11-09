// Detecta sessões `claude` já abertas em outros terminais e infere o estado pelo transcript.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describeTool } = require('./lib/describe');

const run = (cmd, args) =>
  new Promise((res) => execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (_, out) => res(out || '')));

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const encodeCwd = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

async function listProcesses() {
  const out = await run('ps', ['-axo', 'pid=,ppid=,tty=,etime=,command=']);
  const procs = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, ppid, tty, etime, command] = m;
    if (tty === '??' || tty === '?') continue; // só terminais reais (ignora app desktop/helpers)
    const first = command.split(/\s+/)[0];
    if (path.basename(first) !== 'claude') continue;
    procs.push({ pid: +pid, ppid: +ppid, tty, etime, command });
  }
  return procs;
}

async function cwdOf(pids) {
  if (!pids.length) return {};
  const out = await run('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')]);
  const map = {};
  let cur;
  for (const l of out.split('\n')) {
    if (l[0] === 'p') cur = +l.slice(1);
    else if (l[0] === 'n' && cur) map[cur] = l.slice(1);
  }
  return map;
}

function flag(command, name) {
  const m = command.match(new RegExp(`${name}[= ]([^\\s]+)`));
  return m ? m[1] : '';
}

/**
 * Decide o estado a partir do final do transcript.
 * `now` é injetável para teste. Retorna { state, age, model, mtimeMs, detail }.
 */
function inferState(file, now = Date.now()) {
  let st;
  try { st = fs.statSync(file); } catch { return { state: 'standby' }; }
  const age = (now - st.mtimeMs) / 1000;
  const size = st.size, len = Math.min(size, 200000);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  fs.closeSync(fd);

  let last = null;
  for (const line of buf.toString('utf8').split('\n').reverse()) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if ((j.type === 'user' || j.type === 'assistant') && j.message && !j.isSidechain) { last = j; break; }
  }
  const base = { age, mtimeMs: st.mtimeMs };
  if (!last) return { ...base, state: 'standby' };

  const content = Array.isArray(last.message.content) ? last.message.content : [{ type: 'text', text: String(last.message.content || '') }];
  const model = last.message.model;
  if (last.type === 'assistant') {
    const tool = content.filter((c) => c.type === 'tool_use').pop();
    if (tool) {
      // ferramenta pedida e sem resultado: se parou há alguns segundos, está esperando aprovação
      if (age < 6) return { ...base, state: 'processing', model };
      return { ...base, state: 'attention', model, detail: { kind: 'permission', message: '', tool: describeTool(tool.name, tool.input) } };
    }
    if (age < 4) return { ...base, state: 'processing', model };
    const text = content.filter((c) => c.type === 'text').map((c) => c.text).join(' ').trim();
    return { ...base, state: 'done', model, detail: text ? { kind: 'done', message: text.slice(0, 300) } : null };
  }
  // último é do usuário (prompt ou tool_result): o modelo está trabalhando
  return { ...base, state: age < 180 ? 'processing' : 'standby', model };
}

function latestTranscripts(cwd, n) {
  const dir = path.join(PROJECTS, encodeCwd(cwd));
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime).slice(0, n).map((x) => x.file);
  } catch { return []; }
}

/**
 * hookByPid: Map<pid, { transcript }> vindo dos hooks globais. Quando existe, o casamento
 * processo -> transcript é exato; sem ele, cai na heurística por ordem dentro da pasta.
 */
async function detectExternal(excludePids = new Set(), hookByPid = new Map()) {
  const procs = (await listProcesses()).filter((p) => !excludePids.has(p.pid) && !excludePids.has(p.ppid));
  const cwds = await cwdOf(procs.map((p) => p.pid));
  const byCwd = {};
  procs.forEach((p) => { p.cwd = cwds[p.pid]; if (p.cwd) (byCwd[p.cwd] ||= []).push(p); });

  const result = [];
  for (const [cwd, group] of Object.entries(byCwd)) {
    group.sort((a, b) => a.pid - b.pid);
    const assigned = new Map();
    for (const p of group) {
      const t = hookByPid.get(p.pid)?.transcript;
      if (t && fs.existsSync(t)) assigned.set(p.pid, t);
    }
    const used = new Set(assigned.values());
    const pending = group.filter((p) => !assigned.has(p.pid));
    // heurística para os sem hook: mais antigos com os transcripts mais antigos entre os N mais recentes
    const pool = latestTranscripts(cwd, group.length + used.size).filter((f) => !used.has(f)).slice(0, pending.length).reverse();
    pending.forEach((p, i) => pool[i] && assigned.set(p.pid, pool[i]));

    for (const p of group) {
      const file = assigned.get(p.pid) || null;
      const info = file ? inferState(file) : { state: 'standby' };
      result.push({
        pid: p.pid, tty: p.tty, cwd, command: p.command, etime: p.etime,
        model: flag(p.command, '--model') || info.model || '',
        effort: flag(p.command, '--effort'),
        permissionMode: flag(p.command, '--permission-mode'),
        state: info.state, detail: info.detail || null, mtimeMs: info.mtimeMs || 0,
        file, sessionId: file ? path.basename(file, '.jsonl') : null,
        exact: hookByPid.has(p.pid) && assigned.get(p.pid) === hookByPid.get(p.pid).transcript,
      });
    }
  }
  return result;
}

module.exports = { detectExternal, inferState, encodeCwd };

if (require.main === module) detectExternal().then((r) => console.table(r.map(({ command, detail, ...x }) => x)));
