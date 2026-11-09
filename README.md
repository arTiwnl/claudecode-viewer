<div align="center">

# 🧭 Claude Viewer

**Todos os seus Claude Code numa tela só. Com um Kanban que te avisa quando algum precisa de você.**

[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/for-Claude%20Code-d97757)](https://claude.com/claude-code)
![Local only](https://img.shields.io/badge/100%25-local-success)

</div>

---

## O problema

Você abre 5, 8, 12 sessões do Claude Code em abas de terminal diferentes. Uma está pedindo permissão, outra terminou há dez minutos, outra ainda está trabalhando… e você só descobre alternando aba por aba.

**Claude Viewer** resolve isso: um painel local que junta todas as sessões e mostra, em tempo real, o que cada uma está fazendo.

```
┌─ Kanban ───────────────────────────────────────────────────────────────┐
│ Standby   │ Em processamento │ ⚠ Precisa de atenção │ Pronto           │
│ ────────  │ ──────────────── │ ──────────────────── │ ──────────────── │
│ api-docs  │ ● landing-page   │ ● backend-auth       │ ✔ site-pessoal   │
│           │ ● crm-extension  │   aguardando aprovar │ ✔ migração-db    │
└────────────────────────────────────────────────────────────────────────┘

┌─ Terminais ────────────────────────┬───────────────────────────────────┐
│                                    │ landing-page          ● processando│
│   terminal principal               ├───────────────────────────────────┤
│   (metade esquerda da tela)        │ backend-auth          ⚠ atenção   │
│                                    ├───────────────────────────────────┤
│                                    │ migração-db           ✔ pronto    │
└────────────────────────────────────┴───────────────────────────────────┘
```

## ✨ Recursos

- **Kanban automático** com 4 colunas: `Standby` · `Em processamento` · `Precisa de atenção` · `Pronto`
- **Terminais reais dentro do navegador** (xterm.js + PTY): é o `claude` de verdade, não uma simulação
- **Layout inteligente**: um terminal principal na metade esquerda, os demais empilhados à direita. Clicou em um, ele vira o principal
- **Detecta sessões que já estão abertas** nos seus outros terminais e mostra no Kanban, sem você mudar nada
- **Assuma uma sessão externa com um clique**: o app retoma a mesma conversa (`--resume`) dentro do painel
- **Configure cada sessão ao criar**: modelo, effort, modo de permissão, diretórios extras, system prompt, `--continue` e flags livres
- **Alertas**: badge no Kanban, contador no título da aba e notificação do navegador quando uma sessão precisa de atenção
- **Arraste os cards** entre colunas se quiser forçar um status

## 🚀 Começando

Requisitos: **Node 18+** e o [Claude Code](https://claude.com/claude-code) instalado e logado (`claude` no seu `PATH`).

```bash
git clone https://github.com/<seu-usuario>/claude-viewer.git
cd claude-viewer
npm install
npm start
```

Abra **http://localhost:7777** e clique em **+ Nova sessão**.

| Variável    | Padrão   | Para quê                              |
| ----------- | -------- | ------------------------------------- |
| `PORT`      | `7777`   | Porta do servidor                     |
| `CLAUDE_BIN`| `claude` | Caminho do executável do Claude Code  |

## 🧠 Como funciona

O truque é **não adivinhar** o status lendo a tela do terminal.

**Sessões abertas pelo app** sobem com `--settings` apontando para *hooks* do Claude Code. Cada hook avisa o servidor local assim que algo muda:

| Evento do Claude Code        | Coluna              |
| ---------------------------- | ------------------- |
| `SessionStart`               | Standby             |
| `UserPromptSubmit`, `PreToolUse` | Em processamento |
| `Notification` (ex.: pedido de permissão) | Precisa de atenção |
| `Stop`                       | Pronto              |

Nada é escrito na sua configuração global (`~/.claude/settings.json`).

**Sessões já abertas em outros terminais** são encontradas varrendo os processos (`ps` + `lsof`). O estado é inferido lendo o fim do transcript em `~/.claude/projects/`: se o último passo foi uma ferramenta sem resultado, provavelmente está esperando você aprovar.

```
 navegador ──WebSocket──▶ servidor Node ──node-pty──▶ claude (hooks ─curl▶ servidor)
                              │
                              └── ps / lsof / transcripts ──▶ sessões externas
```

## ⚠️ Limitações honestas

- Terminais que **já estão abertos em outro programa** (Terminal.app, iTerm…) não dá para encaixar na tela. O app mostra status e conversa em modo leitura, e o botão **Abrir aqui** faz um *handoff*: encerra o `claude` original e retoma a conversa no painel.
- O status das sessões externas é uma **estimativa** (pode errar por alguns segundos).
- Duas sessões na **mesma pasta** podem ser confundidas na detecção externa.
- As sessões abertas pelo app **morrem quando o servidor para**. Use "Continuar última conversa" para retomar.
- Testado no **macOS**. Linux deve funcionar; Windows não foi testado.

## 🔒 Segurança

Esse app controla terminais, então:

- O servidor escuta **somente em `127.0.0.1`**, nunca na rede.
- Rejeita requisições e WebSockets cuja origem não seja o próprio `localhost:PORT`, o que bloqueia que sites abertos no navegador falem com ele (CSRF / DNS rebinding).
- **Não exponha a porta** com túneis ou proxy reverso: não há autenticação.
- A opção `bypassPermissions` do formulário desliga as confirmações do Claude Code. Use com consciência.

## 🗂️ Estrutura

```
server.js        servidor HTTP/WebSocket, PTYs, hooks e API
detect.js        detecção de sessões externas e inferência de estado
public/          interface (HTML + JS puro, sem build)
```

Sem framework, sem bundler: são ~700 linhas que dá para ler numa tarde.

## 🛣️ Ideias para o futuro

- [ ] Persistir sessões entre reinícios
- [ ] Focar a janela do terminal original ao clicar num card externo
- [ ] Histórico de tempo por coluna (quanto tempo cada sessão ficou esperando você)
- [ ] Envio de prompt para várias sessões de uma vez

Contribuições são bem-vindas: abra uma issue ou um PR.

## 📄 Licença

[MIT](LICENSE)

---

<div align="center">
Feito com <a href="https://claude.com/claude-code">Claude Code</a>, para quem usa muito Claude Code.
</div>
