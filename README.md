<div align="center">

# 🧭 Claude Code Viewer

**Todos os seus Claude Code numa tela só. Com um Kanban que te avisa quando algum precisa de você.**

[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/for-Claude%20Code-d97757)](https://claude.com/claude-code)
![Local only](https://img.shields.io/badge/100%25-local-success)

</div>

---

## O problema

Você abre 5, 8, 12 sessões do Claude Code em abas de terminal diferentes. Uma está pedindo permissão, outra terminou há dez minutos, outra ainda está trabalhando… e você só descobre alternando aba por aba.

**Claude Code Viewer** resolve isso: um painel local que junta todas as sessões e mostra, em tempo real, o que cada uma está fazendo.

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
- **Cada card mostra o que importa**: o que está esperando (`Bash: rm -rf dist`), a última resposta quando termina e **há quanto tempo** está naquela coluna. Quem espera há mais tempo aparece primeiro
- **Aprove ou negue direto do card**, sem abrir o terminal
- **Notificação nativa do sistema** (macOS/Linux) quando alguma sessão precisa de você, mesmo com o navegador em segundo plano
- **Terminais reais dentro do navegador** (xterm.js + PTY): é o `claude` de verdade, não uma simulação. Se a conexão cai, o terminal reconecta sozinho
- **Layout inteligente**: um terminal principal na metade esquerda, os demais empilhados à direita. Clicou em um, ele vira o principal
- **Suas sessões sobrevivem a reinícios**: o app reabre tudo com `--resume`, na mesma conversa
- **Detecta sessões que já estão abertas** nos seus outros terminais e mostra no Kanban, sem você mudar nada
- **Status exato opcional** para essas sessões externas, com um clique (instala hooks no seu `~/.claude/settings.json`, com backup e desfazer)
- **Assuma uma sessão externa com um clique**: o app retoma a mesma conversa (`--resume`) dentro do painel
- **Configure cada sessão ao criar**: modelo, effort, modo de permissão, diretórios extras, system prompt, `--continue` e flags livres
- **Arraste os cards** entre colunas se quiser forçar um status

## 🚀 Começando

Requisitos: **Node 18+** e o [Claude Code](https://claude.com/claude-code) instalado e logado (`claude` no seu `PATH`).

```bash
npx claudecode-viewer
```

Ou clonando:

```bash
git clone https://github.com/arTiwnl/claudecode-viewer.git
cd claudecode-viewer
npm install
npm start
```

Abra **http://localhost:7777** e clique em **+ Nova sessão**.

| Opção / variável         | Padrão   | Para quê                                          |
| ------------------------ | -------- | ------------------------------------------------- |
| `--port` / `PORT`        | `7777`   | Porta do servidor                                 |
| `--no-open`              |          | Não abrir o navegador automaticamente             |
| `CLAUDE_BIN`             | `claude` | Caminho do executável do Claude Code              |
| `NOTIFY=0`               |          | Desliga as notificações do sistema                |

## 🧠 Como funciona

O truque é **não adivinhar** o status lendo a tela do terminal.

**Sessões abertas pelo app** sobem com `--settings` apontando para *hooks* do Claude Code. Cada hook entrega ao servidor local o JSON do evento (`session_id`, ferramenta pedida, mensagem da notificação, última resposta…):

| Evento do Claude Code        | Coluna              |
| ---------------------------- | ------------------- |
| `SessionStart`               | Standby             |
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | Em processamento |
| `Notification` (ex.: pedido de permissão) | Precisa de atenção |
| `Stop`                       | Pronto              |

Nada é escrito na sua configuração global, a não ser que você ligue o **status exato** (veja abaixo). O `session_id` recebido é o que permite reabrir a conversa certa depois de um reinício.

**Aprovar/negar** envia `Enter` ou `Esc` ao prompt de permissão do terminal daquela sessão.

**Sessões já abertas em outros terminais** são encontradas varrendo os processos (`ps` + `lsof`). Sem hooks, o estado é *estimado* lendo o fim do transcript em `~/.claude/projects/`: se o último passo foi uma ferramenta sem resultado, provavelmente está esperando você aprovar.

**Status exato (opcional):** o botão no topo instala os mesmos hooks em `~/.claude/settings.json`. Seus hooks existentes são preservados, é feito um backup (`settings.json.claudecode-viewer.bak`) e o mesmo botão remove tudo. Como o hook sabe o PID do `claude` que o disparou, o casamento processo ↔ conversa deixa de ser uma estimativa. Vale para sessões iniciadas depois de ligar. Com o viewer fechado, os hooks não fazem nada.

```
 navegador ──WebSocket──▶ servidor Node ──node-pty──▶ claude ──hooks (JSON via curl)──▶ servidor
                              │
                              └── ps / lsof / transcripts ──▶ sessões externas
```

## ⚠️ Limitações honestas

- Terminais que **já estão abertos em outro programa** (Terminal.app, iTerm…) não dá para encaixar na tela. O app mostra status e conversa em modo leitura, e o botão **Abrir aqui** faz um *handoff*: encerra o `claude` original e retoma a conversa no painel.
- Sem o status exato ligado, o estado das sessões externas é uma **estimativa** (pode errar por alguns segundos) e duas sessões na **mesma pasta** podem ser confundidas.
- Aprovar/negar só funciona em sessões abertas pelo app, e assume o prompt padrão do Claude Code (`Enter` = sim, `Esc` = não).
- Testado no **macOS**. Linux deve funcionar; Windows não foi testado.

## 🔒 Segurança

Esse app controla terminais, então:

- O servidor escuta **somente em `127.0.0.1`**, nunca na rede.
- Rejeita requisições e WebSockets cuja origem não seja o próprio `localhost:PORT`, o que bloqueia que sites abertos no navegador falem com ele (CSRF / DNS rebinding).
- **Não exponha a porta** com túneis ou proxy reverso: não há autenticação.
- A opção `bypassPermissions` do formulário desliga as confirmações do Claude Code. Use com consciência.

## 🗂️ Estrutura

```
server.js          servidor HTTP/WebSocket, PTYs, hooks, persistência e API
detect.js          detecção de sessões externas e inferência de estado
lib/               regras puras: transição de estado, config de hooks
public/            interface (HTML + JS puro, sem build)
test/              testes (npm test)
```

Sem framework, sem bundler: é código que dá para ler numa tarde. `npm test` roda a suíte (inclui um teste de integração que sobe o servidor de verdade com um `claude` falso).

## 🛣️ Ideias para o futuro

- [ ] Focar a janela do terminal original ao clicar num card externo
- [ ] Enviar um prompt para várias sessões de uma vez
- [ ] Autenticação por token para acessar de outro dispositivo

Contribuições são bem-vindas: abra uma issue ou um PR.

## 📄 Licença

[MIT](LICENSE)

---

<div align="center">
Feito com <a href="https://claude.com/claude-code">Claude Code</a>, para quem usa muito Claude Code.
</div>
