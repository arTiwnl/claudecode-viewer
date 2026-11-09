// Detecta sessões `claude` já abertas em outros terminais e infere o estado pelo transcript.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

// Lê o final do transcript e decide o estado
function inferState(file) {
  let st;
  try { st = fs.statSync(file); } catch { return { state: 'standby' }; }
  const age = (Date.now() - st.mtimeMs) / 1000;
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
  if (!last) return { state: 'standby', age };

  const content = Array.isArray(last.message.content) ? last.message.content : [{ type: 'text', text: String(last.message.content || '') }];
  const model = last.message.model;
  if (last.type === 'assistant') {
    const hasToolUse = content.some((c) => c.type === 'tool_use');
    if (hasToolUse) {
      // ferramenta pedida e sem resultado: se parou há alguns segundos, está esperando aprovação
      return { state: age < 6 ? 'processing' : 'attention', age, model };
    }
    return { state: age < 4 ? 'processing' : 'done', age, model };
  }
  // último é do usuário (prompt ou tool_result): o modelo está trabalhando
  return { state: age < 180 ? 'processing' : 'standby', age, model };
}

function latestTranscripts(cwd, n) {
  const dir = path.join(PROJECTS, encodeCwd(cwd));
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime).slice(0, n).map((x) => x.file);
  } catch { return []; }
}

async function detectExternal(excludePids = new Set()) {
  const procs = (await listProcesses()).filter((p) => !excludePids.has(p.pid) && !excludePids.has(p.ppid));
  const cwds = await cwdOf(procs.map((p) => p.pid));
  const byCwd = {};
  procs.forEach((p) => { p.cwd = cwds[p.pid]; if (p.cwd) (byCwd[p.cwd] ||= []).push(p); });

  const result = [];
  for (const [cwd, group] of Object.entries(byCwd)) {
    // vários claude no mesmo diretório: casa os mais antigos (maior etime) com os transcripts mais antigos dos N mais recentes
    const files = latestTranscripts(cwd, group.length).reverse();
    group.sort((a, b) => a.pid - b.pid);
    group.forEach((p, i) => {
      const info = files[i] ? inferState(files[i]) : { state: 'standby' };
      result.push({
        pid: p.pid, tty: p.tty, cwd, command: p.command, etime: p.etime,
        model: flag(p.command, '--model') || info.model || '',
        effort: flag(p.command, '--effort'),
        permissionMode: flag(p.command, '--permission-mode'),
        state: info.state, file: files[i] || null, sessionId: files[i] ? path.basename(files[i], '.jsonl') : null,
      });
    });
  }
  return result;
}

module.exports = { detectExternal };

if (require.main === module) detectExternal().then((r) => console.table(r.map(({ command, ...x }) => x)));
