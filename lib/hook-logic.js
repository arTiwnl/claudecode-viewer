// Regras puras de transição de estado (sem I/O, fáceis de testar).
const { describeTool } = require('./describe');

const PERMISSION_RE = /permission|approve|allow/i;
const IDLE_RE = /waiting for your input/i;

/**
 * prev: { state, lastTool }  state: estado pedido pelo hook  body: JSON recebido do Claude Code
 * Retorna { state, detail, lastTool } ou null se o evento deve ser ignorado.
 */
function nextState(prev, state, body = {}) {
  let lastTool = prev.lastTool || '';
  if (body.hook_event_name === 'PreToolUse' && body.tool_name) lastTool = describeTool(body.tool_name, body.tool_input);

  if (state === 'attention') {
    const msg = body.message || '';
    const nt = body.notification_type;
    const idle = nt === 'idle_prompt' || IDLE_RE.test(msg);
    // "Claude está esperando sua resposta" depois de terminar não é um pedido novo
    if (idle && (prev.state === 'done' || prev.state === 'standby')) return null;
    const kind = idle ? 'idle' : nt === 'permission_prompt' || PERMISSION_RE.test(msg) ? 'permission' : 'other';
    return { state, detail: { kind, message: msg, tool: lastTool }, lastTool };
  }
  if (state === 'done') {
    const m = (body.last_assistant_message || '').trim();
    return { state, detail: m ? { kind: 'done', message: m.slice(0, 300) } : null, lastTool: '' };
  }
  if (state === 'standby') return { state, detail: null, lastTool: '' };
  return { state, detail: null, lastTool }; // processing
}

/**
 * Sessões externas: combina o que os hooks disseram com a inferência pelo transcript.
 * h: { state, detail, ts } | undefined
 */
function mergeExternalState(h, inferred, mtimeMs, now = Date.now()) {
  if (!h || !h.state) return { state: inferred, fromHooks: false };
  // pedido de permissão respondido sem hook (ex.: Esc): o transcript andou depois
  if (h.state === 'attention' && mtimeMs && mtimeMs > h.ts + 4000) return { state: inferred, fromHooks: false };
  // "processando" há muito tempo e o transcript parado: provavelmente foi interrompido
  if (h.state === 'processing' && now - h.ts > 60000 && inferred === 'standby') return { state: inferred, fromHooks: false };
  return { state: h.state, detail: h.detail, fromHooks: true };
}

module.exports = { nextState, mergeExternalState };
