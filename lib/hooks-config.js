// Monta e (des)instala os hooks do Claude Code que alimentam o viewer.
const MARKER = 'claudecode-viewer-hook';

// evento do Claude Code -> coluna do Kanban
const EVENTS = {
  SessionStart: 'standby',
  UserPromptSubmit: 'processing',
  PreToolUse: 'processing',
  PostToolUse: 'processing',
  Notification: 'attention',
  Stop: 'done',
};

// Lê o JSON do hook via stdin e manda ao viewer. $PPID é o PID do próprio `claude`.
// "|| true" garante que, com o viewer fechado, nada quebra no Claude Code.
function hookCommand(port, state) {
  return (
    `curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- ` +
    `"http://127.0.0.1:${port}/hook/\${CLAUDE_VIEWER_ID:-ext}/${state}?ppid=$PPID" >/dev/null 2>&1 || true # ${MARKER}`
  );
}

function buildHooks(port) {
  const hooks = {};
  for (const [event, state] of Object.entries(EVENTS)) {
    hooks[event] = [{ hooks: [{ type: 'command', command: hookCommand(port, state) }] }];
  }
  return hooks;
}

const isOurs = (entry) =>
  Array.isArray(entry && entry.hooks) && entry.hooks.some((h) => typeof h.command === 'string' && h.command.includes(MARKER));

function removeHooks(settings) {
  const out = JSON.parse(JSON.stringify(settings || {}));
  if (!out.hooks) return out;
  for (const event of Object.keys(out.hooks)) {
    out.hooks[event] = (out.hooks[event] || []).filter((e) => !isOurs(e));
    if (!out.hooks[event].length) delete out.hooks[event];
  }
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return out;
}

// Mescla sem tocar nos hooks que o usuário já tem
function addHooks(settings, port) {
  const out = removeHooks(settings);
  out.hooks = out.hooks || {};
  for (const [event, entries] of Object.entries(buildHooks(port))) {
    out.hooks[event] = [...(out.hooks[event] || []), ...entries];
  }
  return out;
}

const hasHooks = (settings) =>
  Object.values((settings && settings.hooks) || {}).some((list) => (list || []).some(isOurs));

module.exports = { MARKER, EVENTS, hookCommand, buildHooks, addHooks, removeHooks, hasHooks };
