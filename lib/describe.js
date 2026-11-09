// Resume uma chamada de ferramenta numa linha legível: "Bash: npm test"
function describeTool(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const v = i.command || i.file_path || i.path || i.url || i.pattern || i.description || JSON.stringify(i);
  return `${name}: ${String(v).replace(/\s+/g, ' ').trim().slice(0, 200)}`;
}
module.exports = { describeTool };
