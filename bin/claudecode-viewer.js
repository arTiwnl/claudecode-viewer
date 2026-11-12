#!/usr/bin/env node
const { execFile } = require('child_process');
const args = process.argv.slice(2);
const val = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

if (args.includes('-h') || args.includes('--help')) {
  console.log(`claudecode-viewer: todos os seus Claude Code numa tela só

Uso: npx claudecode-viewer [opções]

  --port <n>    porta (padrão 7777)
  --remote      aceita acesso de outros computadores (exige token; escuta em 0.0.0.0)
  --host <ip>   endereço em que escutar (implica modo remoto se não for localhost)
  --no-open     não abrir o navegador
  -h, --help    esta ajuda

Variáveis: PORT, HOST, REMOTE=1, CLAUDE_VIEWER_TOKEN, CLAUDE_BIN, NOTIFY=0 (desliga notificações do sistema)`);
  process.exit(0);
}
if (val('--port')) process.env.PORT = val('--port');
if (val('--host')) process.env.HOST = val('--host');
if (args.includes('--remote')) process.env.REMOTE = '1';
const port = process.env.PORT || 7777;
require('../server.js');
if (!args.includes('--no-open')) {
  const opener = { darwin: 'open', linux: 'xdg-open', win32: 'explorer' }[process.platform];
  if (opener) setTimeout(() => execFile(opener, [`http://localhost:${port}`], () => {}), 800);
}
