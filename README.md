# ClinicaApp — Sistema de Ficha de Atendimento

Sistema desktop leve para clínicas de pequeno porte, consultórios e profissionais de saúde.
Substitui fichas de papel com uma interface profissional, moderna e extremamente rápida de usar.

---

## Arquitetura adotada

```
clinica-app/
├── backend/              ← Node.js + Express + better-sqlite3
│   ├── server.js         ← API REST completa (arquivo único)
│   └── package.json
│
├── frontend/             ← React + Vite
│   ├── src/
│   │   ├── main.jsx
│   │   ├── App.jsx       ← Todos os componentes (arquivo único)
│   │   └── App.css       ← CSS completo com dark mode
│   ├── index.html
│   ├── package.json
│   └── vite.config.js
│
└── src-tauri/            ← Tauri (wrapper desktop)
    ├── src/main.rs       ← Inicia o sidecar Node.js
    ├── tauri.conf.json
    └── Cargo.toml
```

### Por que esta arquitetura?

O backend Node.js é compilado como um **sidecar** pelo Tauri: um executável
independente que roda em paralelo ao app. O Tauri inicia o sidecar ao abrir o
app e o encerra quando o usuário fecha. O frontend React se comunica com ele
via `fetch` em `http://127.0.0.1:3477`.

**Por que `better-sqlite3` e não `sqlite3`?**
O módulo `sqlite3` usa N-API com bindings assíncronos e tem problemas sérios
com `pkg`/`@yao-pkg/pkg`. O `better-sqlite3` é síncrono, tem excelente
suporte a empacotamento e é mais performático para este tipo de uso.

---

## Banco de dados

```sql
-- Pacientes
CREATE TABLE pacientes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  nome          TEXT NOT NULL,
  nascimento    TEXT,          -- ISO 8601: YYYY-MM-DD
  cpf           TEXT UNIQUE,
  telefone      TEXT,
  email         TEXT,
  endereco      TEXT,
  convenio      TEXT,
  observacoes   TEXT,
  criado_em     TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- Atendimentos
CREATE TABLE atendimentos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  paciente_id   INTEGER NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
  data_atend    TEXT NOT NULL,
  tipo          TEXT NOT NULL DEFAULT 'Consulta',
  profissional  TEXT,
  queixa        TEXT,
  diagnostico   TEXT,
  conduta       TEXT,
  observacoes   TEXT,
  retorno       TEXT,
  criado_em     TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
```

---

## Endpoints da API

| Método | Rota                              | Descrição                     |
|--------|-----------------------------------|-------------------------------|
| GET    | /health                           | Health check                  |
| GET    | /stats                            | Dashboard stats               |
| GET    | /pacientes                        | Listar com busca/paginação    |
| GET    | /pacientes/:id                    | Ficha completa + atendimentos |
| POST   | /pacientes                        | Cadastrar paciente            |
| PUT    | /pacientes/:id                    | Atualizar paciente            |
| DELETE | /pacientes/:id                    | Excluir paciente (cascade)    |
| GET    | /pacientes/:id/atendimentos       | Histórico de atendimentos     |
| POST   | /pacientes/:id/atendimentos       | Registrar atendimento         |
| PUT    | /atendimentos/:id                 | Editar atendimento            |
| DELETE | /atendimentos/:id                 | Excluir atendimento           |

Query params para GET /pacientes:
- `busca` — texto para filtrar por nome, CPF ou telefone
- `page` — página (default: 1)
- `limit` — itens por página (default: 20, max: 100)

---

## Como rodar em desenvolvimento

### 1. Backend

```bash
cd backend
npm install
npm run dev
# Rodando em http://127.0.0.1:3477
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
# Abre em http://localhost:5173
```

Abra `http://localhost:5173` no navegador. O backend deve estar rodando
antes.

### 3. Tauri (modo dev, abre janela nativa)

```bash
# Instale o Tauri CLI globalmente
npm install -g @tauri-apps/cli

# Na raiz do projeto
npx tauri dev
```

O Tauri vai abrir uma janela desktop que carrega o frontend em dev mode.
O sidecar ainda **não é usado** em dev — o backend fica rodando separado.

---

## Como gerar o executável .exe

### Pré-requisitos

1. **Rust** — https://rustup.rs (instale com target `x86_64-pc-windows-msvc`)
2. **Node.js 18+**
3. **@yao-pkg/pkg** — `npm install -g @yao-pkg/pkg`
4. **Tauri CLI** — `npm install -g @tauri-apps/cli`
5. **WebView2** — já vem no Windows 10/11, mas pode ser baixado em
   https://developer.microsoft.com/pt-br/microsoft-edge/webview2/

### Passo a passo

```bash
# 1. Compile o backend como .exe (sidecar)
cd backend
npm install
npx @yao-pkg/pkg . --target node18-win-x64 \
  --output ../src-tauri/binaries/clinica-server-x86_64-pc-windows-msvc.exe

# 2. Build do frontend
cd ../frontend
npm install
npm run build

# 3. Build do Tauri
cd ..
npx tauri build
```

O instalador `.msi` e o `.exe` portátil estarão em:
`src-tauri/target/release/bundle/`

Ou use o script automatizado:
```bash
build-windows.bat
```

---

## Cuidados e armadilhas comuns

### ⚠️ better-sqlite3 e pkg

`better-sqlite3` usa um binding nativo (`.node`). Ao empacotar com `pkg`,
você precisa garantir que o `.node` correto para a plataforma alvo seja
incluído. Use `@yao-pkg/pkg` (fork mantido) em vez do `pkg` original
(abandonado). Se o binding não for encontrado, o app vai crashar na inicialização.

Solução: após `npm install`, copie o arquivo
`node_modules/better-sqlite3/build/Release/better_sqlite3.node`
para junto do executável gerado, ou configure o `pkg.assets` no package.json:

```json
"pkg": {
  "assets": ["node_modules/better-sqlite3/build/Release/better_sqlite3.node"]
}
```

### ⚠️ Porta ocupada

A porta 3477 pode estar em uso. Em produção, implemente busca por porta
livre usando o módulo `net` do Node.js antes de subir o Express, e
comunique a porta ao frontend via variável de ambiente ou arquivo temporário.

### ⚠️ Nome do sidecar no Tauri

O Tauri exige que o sidecar tenha um nome específico incluindo o target triple.
Em Windows 64-bit: `clinica-server-x86_64-pc-windows-msvc.exe`
O nome configurado em `tauri.conf.json` como `"clinica-server"` é o nome base
— o Tauri adiciona o triple automaticamente.

### ⚠️ CSP no Tauri

A Content Security Policy no `tauri.conf.json` deve explicitamente permitir
conexões para `http://127.0.0.1:3477`. Se você ver erros de CORS ou CSP,
verifique a seção `security.csp`.

### ⚠️ Caminho do banco de dados

Em desenvolvimento: `clinica.db` é criado na pasta `backend/`.
Em produção: o `main.rs` passa `DB_PATH` apontando para
`%APPDATA%\ClinicaApp\clinica.db` (via `app.path_resolver().app_data_dir()`).
Nunca salve o banco em `Program Files` — Windows não permite escrita lá.

### ⚠️ Antivírus

Executáveis Node.js empacotados com `pkg` frequentemente são flagrados como
falso positivo por antivírus. Para distribuição comercial, considere assinar
o executável com um certificado de code signing.

---

## Roadmap sugerido para versão comercial

- [ ] Autenticação multi-usuário (JWT)
- [ ] Backup automático do banco SQLite
- [ ] Exportação de ficha em PDF
- [ ] Upload de exames/documentos por paciente
- [ ] Agenda / calendário de consultas
- [ ] Relatórios de atendimentos por período
- [ ] Suporte a múltiplos consultórios
- [ ] Sincronização opcional com nuvem
# sistema_clinica
