// node-pty vem sem permissão de execução no spawn-helper em alguns ambientes (macOS): corrige.
const fs = require('fs');
const path = require('path');
try {
  const root = path.dirname(require.resolve('node-pty/package.json'));
  const pre = path.join(root, 'prebuilds');
  for (const d of fs.existsSync(pre) ? fs.readdirSync(pre) : []) {
    const f = path.join(pre, d, 'spawn-helper');
    if (fs.existsSync(f)) fs.chmodSync(f, 0o755);
  }
} catch {}
