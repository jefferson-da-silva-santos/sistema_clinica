/**
 * ClinicaDesk - Backend Server
 * Node.js + Express + SQLite (CommonJS)
 * Arquivo único, organizado por domínio
 */

'use strict';

const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3456;
const IS_PKG = typeof process.pkg !== 'undefined';
const BASE_DIR = IS_PKG ? path.dirname(process.execPath) : __dirname;
const DATA_DIR = path.join(BASE_DIR, 'clinicadesk_data');
const DB_PATH = path.join(DATA_DIR, 'clinica.db');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

[DATA_DIR, UPLOADS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── APP ─────────────────────────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));

// ─── DATABASE ────────────────────────────────────────────────────────────────

const db = new sqlite3.Database(DB_PATH);

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// ─── SCHEMA ───────────────────────────────────────────────────────────────────

async function initSchema() {
  await dbRun('PRAGMA journal_mode=WAL');
  await dbRun('PRAGMA foreign_keys=ON');

  await dbRun(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      senha_hash TEXT NOT NULL,
      perfil TEXT NOT NULL CHECK(perfil IN ('admin','profissional','recepcionista')),
      ativo INTEGER DEFAULT 1,
      criado_em TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS pacientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      cpf TEXT UNIQUE NOT NULL,
      telefone TEXT,
      email TEXT,
      data_nascimento TEXT,
      sexo TEXT CHECK(sexo IN ('M','F','O')),
      endereco TEXT,
      convenio TEXT,
      observacoes TEXT,
      ativo INTEGER DEFAULT 1,
      criado_em TEXT DEFAULT (datetime('now','localtime')),
      atualizado_em TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS agendamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      paciente_id INTEGER NOT NULL REFERENCES pacientes(id),
      profissional_id INTEGER NOT NULL REFERENCES usuarios(id),
      data_hora TEXT NOT NULL,
      duracao_min INTEGER DEFAULT 30,
      tipo TEXT NOT NULL,
      status TEXT DEFAULT 'agendado' CHECK(status IN ('agendado','confirmado','em_atendimento','finalizado','cancelado','faltou')),
      observacoes TEXT,
      lembrete_enviado INTEGER DEFAULT 0,
      criado_em TEXT DEFAULT (datetime('now','localtime')),
      atualizado_em TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS atendimentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      paciente_id INTEGER NOT NULL REFERENCES pacientes(id),
      profissional_id INTEGER NOT NULL REFERENCES usuarios(id),
      agendamento_id INTEGER REFERENCES agendamentos(id),
      data_hora TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      tipo TEXT NOT NULL,
      motivo TEXT NOT NULL,
      anamnese TEXT,
      diagnostico TEXT,
      conduta TEXT,
      observacoes TEXT,
      retorno_em TEXT,
      status TEXT DEFAULT 'em_atendimento' CHECK(status IN ('em_atendimento','finalizado','cancelado')),
      criado_em TEXT DEFAULT (datetime('now','localtime')),
      atualizado_em TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS anexos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      atendimento_id INTEGER NOT NULL REFERENCES atendimentos(id) ON DELETE CASCADE,
      nome_original TEXT NOT NULL,
      nome_arquivo TEXT NOT NULL,
      tipo_mime TEXT,
      tamanho_bytes INTEGER,
      descricao TEXT,
      criado_em TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER REFERENCES usuarios(id),
      usuario_nome TEXT,
      acao TEXT NOT NULL,
      entidade TEXT NOT NULL,
      entidade_id INTEGER,
      detalhes TEXT,
      ip TEXT,
      criado_em TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS alertas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT NOT NULL CHECK(tipo IN ('retorno','consulta','sistema')),
      titulo TEXT NOT NULL,
      mensagem TEXT,
      paciente_id INTEGER REFERENCES pacientes(id),
      agendamento_id INTEGER REFERENCES agendamentos(id),
      usuario_id INTEGER REFERENCES usuarios(id),
      lido INTEGER DEFAULT 0,
      criado_em TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // Índices
  await dbRun('CREATE INDEX IF NOT EXISTS idx_pac_cpf ON pacientes(cpf)');
  await dbRun('CREATE INDEX IF NOT EXISTS idx_pac_nome ON pacientes(nome)');
  await dbRun('CREATE INDEX IF NOT EXISTS idx_agend_data ON agendamentos(data_hora)');
  await dbRun('CREATE INDEX IF NOT EXISTS idx_agend_prof ON agendamentos(profissional_id)');
  await dbRun('CREATE INDEX IF NOT EXISTS idx_atend_pac ON atendimentos(paciente_id)');
  await dbRun('CREATE INDEX IF NOT EXISTS idx_logs_data ON logs(criado_em)');

  // Admin padrão
  const adminExiste = await dbGet("SELECT id FROM usuarios WHERE email='admin@clinica.local'");
  if (!adminExiste) {
    const hash = hashSenha('admin123');
    await dbRun(
      "INSERT INTO usuarios (nome, email, senha_hash, perfil) VALUES (?,?,?,?)",
      ['Administrador', 'admin@clinica.local', hash, 'admin']
    );
    console.log('[DB] Usuário admin criado: admin@clinica.local / admin123');
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function hashSenha(senha) {
  return crypto.createHash('sha256').update(senha + 'clinicadesk_salt').digest('hex');
}

function respOk(res, data, msg = 'OK') {
  res.json({ sucesso: true, mensagem: msg, dados: data });
}

function respErro(res, msg, status = 400) {
  res.status(status).json({ sucesso: false, mensagem: msg, dados: null });
}

async function registrarLog(usuarioId, usuarioNome, acao, entidade, entidadeId, detalhes = null) {
  try {
    await dbRun(
      'INSERT INTO logs (usuario_id, usuario_nome, acao, entidade, entidade_id, detalhes) VALUES (?,?,?,?,?,?)',
      [usuarioId, usuarioNome, acao, entidade, entidadeId, detalhes ? JSON.stringify(detalhes) : null]
    );
  } catch (e) { /* log não deve quebrar o fluxo */ }
}

// Middleware de auth simples via header
function authMiddleware(req, res, next) {
  const token = req.headers['x-usuario-id'];
  const nome = req.headers['x-usuario-nome'];
  const perfil = req.headers['x-usuario-perfil'];
  if (!token) return respErro(res, 'Não autenticado', 401);
  req.usuarioId = parseInt(token);
  req.usuarioNome = nome || 'Sistema';
  req.usuarioPerfil = perfil || 'recepcionista';
  next();
}

function requirePerfil(...perfis) {
  return (req, res, next) => {
    if (!perfis.includes(req.usuarioPerfil)) {
      return respErro(res, 'Acesso não autorizado para este perfil', 403);
    }
    next();
  };
}

// ─── MULTER ───────────────────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const nome = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`;
    cb(null, nome);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg','image/png','image/gif','application/pdf',
      'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    cb(null, allowed.includes(file.mimetype));
  }
});

// ─── ROTAS: AUTH ─────────────────────────────────────────────────────────────

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) return respErro(res, 'Email e senha obrigatórios');
    const hash = hashSenha(senha);
    const usuario = await dbGet(
      'SELECT id, nome, email, perfil FROM usuarios WHERE email=? AND senha_hash=? AND ativo=1',
      [email, hash]
    );
    if (!usuario) return respErro(res, 'Credenciais inválidas', 401);
    await registrarLog(usuario.id, usuario.nome, 'LOGIN', 'usuarios', usuario.id);
    respOk(res, usuario, 'Login realizado');
  } catch (e) { respErro(res, e.message, 500); }
});

// ─── ROTAS: USUÁRIOS ─────────────────────────────────────────────────────────

app.get('/api/usuarios', authMiddleware, requirePerfil('admin'), async (req, res) => {
  try {
    const rows = await dbAll('SELECT id, nome, email, perfil, ativo, criado_em FROM usuarios ORDER BY nome');
    respOk(res, rows);
  } catch (e) { respErro(res, e.message, 500); }
});

app.post('/api/usuarios', authMiddleware, requirePerfil('admin'), async (req, res) => {
  try {
    const { nome, email, senha, perfil } = req.body;
    if (!nome || !email || !senha || !perfil) return respErro(res, 'Campos obrigatórios faltando');
    const hash = hashSenha(senha);
    const r = await dbRun(
      'INSERT INTO usuarios (nome, email, senha_hash, perfil) VALUES (?,?,?,?)',
      [nome, email, hash, perfil]
    );
    await registrarLog(req.usuarioId, req.usuarioNome, 'CRIACAO', 'usuarios', r.lastID, { nome, email, perfil });
    respOk(res, { id: r.lastID }, 'Usuário criado');
  } catch (e) {
    if (e.message.includes('UNIQUE')) return respErro(res, 'Email já cadastrado');
    respErro(res, e.message, 500);
  }
});

app.put('/api/usuarios/:id', authMiddleware, requirePerfil('admin'), async (req, res) => {
  try {
    const { nome, email, perfil, ativo, senha } = req.body;
    const id = req.params.id;
    if (senha) {
      const hash = hashSenha(senha);
      await dbRun('UPDATE usuarios SET nome=?, email=?, perfil=?, ativo=?, senha_hash=? WHERE id=?',
        [nome, email, perfil, ativo, hash, id]);
    } else {
      await dbRun('UPDATE usuarios SET nome=?, email=?, perfil=?, ativo=? WHERE id=?',
        [nome, email, perfil, ativo, id]);
    }
    await registrarLog(req.usuarioId, req.usuarioNome, 'EDICAO', 'usuarios', id);
    respOk(res, null, 'Usuário atualizado');
  } catch (e) { respErro(res, e.message, 500); }
});

app.delete('/api/usuarios/:id', authMiddleware, requirePerfil('admin'), async (req, res) => {
  try {
    const id = req.params.id;
    if (parseInt(id) === req.usuarioId) return respErro(res, 'Não pode excluir a si mesmo');
    await dbRun('UPDATE usuarios SET ativo=0 WHERE id=?', [id]);
    await registrarLog(req.usuarioId, req.usuarioNome, 'EXCLUSAO', 'usuarios', id);
    respOk(res, null, 'Usuário desativado');
  } catch (e) { respErro(res, e.message, 500); }
});

// ─── ROTAS: PACIENTES ────────────────────────────────────────────────────────

app.get('/api/pacientes', authMiddleware, async (req, res) => {
  try {
    const { q, cpf, pagina = 1, limite = 20 } = req.query;
    const offset = (parseInt(pagina) - 1) * parseInt(limite);
    let where = 'WHERE p.ativo=1';
    const params = [];
    if (q) { where += ' AND (p.nome LIKE ? OR p.telefone LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
    if (cpf) { where += ' AND p.cpf LIKE ?'; params.push(`%${cpf}%`); }

    const total = await dbGet(`SELECT COUNT(*) as n FROM pacientes p ${where}`, params);
    const rows = await dbAll(
      `SELECT p.*, 
        (SELECT COUNT(*) FROM atendimentos a WHERE a.paciente_id=p.id) as total_atendimentos,
        (SELECT MAX(a.data_hora) FROM atendimentos a WHERE a.paciente_id=p.id) as ultimo_atendimento
       FROM pacientes p ${where} ORDER BY p.nome LIMIT ? OFFSET ?`,
      [...params, parseInt(limite), offset]
    );
    respOk(res, { pacientes: rows, total: total.n, pagina: parseInt(pagina), limite: parseInt(limite) });
  } catch (e) { respErro(res, e.message, 500); }
});

app.get('/api/pacientes/:id', authMiddleware, async (req, res) => {
  try {
    const pac = await dbGet('SELECT * FROM pacientes WHERE id=? AND ativo=1', [req.params.id]);
    if (!pac) return respErro(res, 'Paciente não encontrado', 404);
    respOk(res, pac);
  } catch (e) { respErro(res, e.message, 500); }
});

app.post('/api/pacientes', authMiddleware, async (req, res) => {
  try {
    const { nome, cpf, telefone, email, data_nascimento, sexo, endereco, convenio, observacoes } = req.body;
    if (!nome || !cpf) return respErro(res, 'Nome e CPF são obrigatórios');
    const cpfLimpo = cpf.replace(/\D/g, '');
    if (cpfLimpo.length !== 11) return respErro(res, 'CPF inválido');
    const r = await dbRun(
      `INSERT INTO pacientes (nome, cpf, telefone, email, data_nascimento, sexo, endereco, convenio, observacoes)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [nome, cpfLimpo, telefone, email, data_nascimento, sexo, endereco, convenio, observacoes]
    );
    await registrarLog(req.usuarioId, req.usuarioNome, 'CRIACAO', 'pacientes', r.lastID, { nome, cpf: cpfLimpo });
    respOk(res, { id: r.lastID }, 'Paciente cadastrado');
  } catch (e) {
    if (e.message.includes('UNIQUE')) return respErro(res, 'CPF já cadastrado');
    respErro(res, e.message, 500);
  }
});

app.put('/api/pacientes/:id', authMiddleware, async (req, res) => {
  try {
    const { nome, cpf, telefone, email, data_nascimento, sexo, endereco, convenio, observacoes } = req.body;
    const cpfLimpo = (cpf || '').replace(/\D/g, '');
    await dbRun(
      `UPDATE pacientes SET nome=?, cpf=?, telefone=?, email=?, data_nascimento=?, sexo=?, 
       endereco=?, convenio=?, observacoes=?, atualizado_em=datetime('now','localtime') WHERE id=?`,
      [nome, cpfLimpo, telefone, email, data_nascimento, sexo, endereco, convenio, observacoes, req.params.id]
    );
    await registrarLog(req.usuarioId, req.usuarioNome, 'EDICAO', 'pacientes', req.params.id);
    respOk(res, null, 'Paciente atualizado');
  } catch (e) { respErro(res, e.message, 500); }
});

app.delete('/api/pacientes/:id', authMiddleware, requirePerfil('admin'), async (req, res) => {
  try {
    await dbRun('UPDATE pacientes SET ativo=0 WHERE id=?', [req.params.id]);
    await registrarLog(req.usuarioId, req.usuarioNome, 'EXCLUSAO', 'pacientes', req.params.id);
    respOk(res, null, 'Paciente removido');
  } catch (e) { respErro(res, e.message, 500); }
});

// ─── ROTAS: AGENDAMENTOS ─────────────────────────────────────────────────────

app.get('/api/agendamentos', authMiddleware, async (req, res) => {
  try {
    const { data, profissional_id, status, paciente_id, data_inicio, data_fim } = req.query;
    let where = 'WHERE 1=1';
    const params = [];

    if (data) { where += ' AND DATE(ag.data_hora)=?'; params.push(data); }
    if (data_inicio) { where += ' AND DATE(ag.data_hora)>=?'; params.push(data_inicio); }
    if (data_fim) { where += ' AND DATE(ag.data_hora)<=?'; params.push(data_fim); }
    if (profissional_id) { where += ' AND ag.profissional_id=?'; params.push(profissional_id); }
    if (status) { where += ' AND ag.status=?'; params.push(status); }
    if (paciente_id) { where += ' AND ag.paciente_id=?'; params.push(paciente_id); }

    const rows = await dbAll(`
      SELECT ag.*, p.nome as paciente_nome, p.telefone as paciente_telefone,
             u.nome as profissional_nome
      FROM agendamentos ag
      JOIN pacientes p ON p.id=ag.paciente_id
      JOIN usuarios u ON u.id=ag.profissional_id
      ${where}
      ORDER BY ag.data_hora ASC
    `, params);
    respOk(res, rows);
  } catch (e) { respErro(res, e.message, 500); }
});

app.post('/api/agendamentos', authMiddleware, async (req, res) => {
  try {
    const { paciente_id, profissional_id, data_hora, duracao_min = 30, tipo, observacoes } = req.body;
    if (!paciente_id || !profissional_id || !data_hora || !tipo)
      return respErro(res, 'Campos obrigatórios: paciente, profissional, data/hora, tipo');

    // Verificar conflito de agendamento
    const conflito = await dbGet(`
      SELECT id FROM agendamentos
      WHERE profissional_id=? AND status NOT IN ('cancelado','faltou')
      AND datetime(data_hora) < datetime(?, '+' || ? || ' minutes')
      AND datetime(data_hora, '+' || duracao_min || ' minutes') > datetime(?)
    `, [profissional_id, data_hora, duracao_min, data_hora]);

    if (conflito) return respErro(res, 'Conflito de horário: profissional já possui agendamento neste período');

    const r = await dbRun(
      `INSERT INTO agendamentos (paciente_id, profissional_id, data_hora, duracao_min, tipo, observacoes)
       VALUES (?,?,?,?,?,?)`,
      [paciente_id, profissional_id, data_hora, duracao_min, tipo, observacoes]
    );

    // Criar alerta automático
    await dbRun(
      `INSERT INTO alertas (tipo, titulo, mensagem, paciente_id, agendamento_id, usuario_id)
       VALUES ('consulta', 'Novo agendamento', ?, ?, ?, ?)`,
      [`Consulta agendada para ${data_hora}`, paciente_id, r.lastID, profissional_id]
    );

    await registrarLog(req.usuarioId, req.usuarioNome, 'CRIACAO', 'agendamentos', r.lastID, { paciente_id, data_hora });
    respOk(res, { id: r.lastID }, 'Agendamento criado');
  } catch (e) { respErro(res, e.message, 500); }
});

app.put('/api/agendamentos/:id', authMiddleware, async (req, res) => {
  try {
    const { status, observacoes, data_hora, duracao_min, tipo, profissional_id } = req.body;
    const id = req.params.id;

    // Verificar conflito se mudando horário
    if (data_hora && profissional_id) {
      const conflito = await dbGet(`
        SELECT id FROM agendamentos
        WHERE profissional_id=? AND id!=? AND status NOT IN ('cancelado','faltou')
        AND datetime(data_hora) < datetime(?, '+' || ? || ' minutes')
        AND datetime(data_hora, '+' || duracao_min || ' minutes') > datetime(?)
      `, [profissional_id, id, data_hora, duracao_min || 30, data_hora]);
      if (conflito) return respErro(res, 'Conflito de horário');
    }

    await dbRun(
      `UPDATE agendamentos SET status=COALESCE(?,status), observacoes=COALESCE(?,observacoes),
       data_hora=COALESCE(?,data_hora), duracao_min=COALESCE(?,duracao_min), tipo=COALESCE(?,tipo),
       atualizado_em=datetime('now','localtime') WHERE id=?`,
      [status, observacoes, data_hora, duracao_min, tipo, id]
    );
    await registrarLog(req.usuarioId, req.usuarioNome, 'EDICAO', 'agendamentos', id, { status });
    respOk(res, null, 'Agendamento atualizado');
  } catch (e) { respErro(res, e.message, 500); }
});

app.delete('/api/agendamentos/:id', authMiddleware, async (req, res) => {
  try {
    await dbRun("UPDATE agendamentos SET status='cancelado' WHERE id=?", [req.params.id]);
    await registrarLog(req.usuarioId, req.usuarioNome, 'CANCELAMENTO', 'agendamentos', req.params.id);
    respOk(res, null, 'Agendamento cancelado');
  } catch (e) { respErro(res, e.message, 500); }
});

// ─── ROTAS: ATENDIMENTOS ─────────────────────────────────────────────────────

app.get('/api/atendimentos', authMiddleware, async (req, res) => {
  try {
    const { paciente_id, profissional_id, data_inicio, data_fim, tipo, status } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (paciente_id) { where += ' AND at.paciente_id=?'; params.push(paciente_id); }
    if (profissional_id) { where += ' AND at.profissional_id=?'; params.push(profissional_id); }
    if (data_inicio) { where += ' AND DATE(at.data_hora)>=?'; params.push(data_inicio); }
    if (data_fim) { where += ' AND DATE(at.data_hora)<=?'; params.push(data_fim); }
    if (tipo) { where += ' AND at.tipo=?'; params.push(tipo); }
    if (status) { where += ' AND at.status=?'; params.push(status); }

    const rows = await dbAll(`
      SELECT at.*, p.nome as paciente_nome, p.cpf as paciente_cpf,
             u.nome as profissional_nome,
             (SELECT COUNT(*) FROM anexos a WHERE a.atendimento_id=at.id) as total_anexos
      FROM atendimentos at
      JOIN pacientes p ON p.id=at.paciente_id
      JOIN usuarios u ON u.id=at.profissional_id
      ${where}
      ORDER BY at.data_hora DESC
    `, params);
    respOk(res, rows);
  } catch (e) { respErro(res, e.message, 500); }
});

app.get('/api/atendimentos/:id', authMiddleware, async (req, res) => {
  try {
    const at = await dbGet(`
      SELECT at.*, p.nome as paciente_nome, p.cpf as paciente_cpf, p.data_nascimento,
             u.nome as profissional_nome
      FROM atendimentos at
      JOIN pacientes p ON p.id=at.paciente_id
      JOIN usuarios u ON u.id=at.profissional_id
      WHERE at.id=?
    `, [req.params.id]);
    if (!at) return respErro(res, 'Atendimento não encontrado', 404);
    const anexos = await dbAll('SELECT * FROM anexos WHERE atendimento_id=?', [req.params.id]);
    respOk(res, { ...at, anexos });
  } catch (e) { respErro(res, e.message, 500); }
});

app.post('/api/atendimentos', authMiddleware, async (req, res) => {
  try {
    const { paciente_id, profissional_id, agendamento_id, tipo, motivo, anamnese, diagnostico, conduta, observacoes, retorno_em } = req.body;
    if (!paciente_id || !profissional_id || !tipo || !motivo)
      return respErro(res, 'Campos obrigatórios: paciente, profissional, tipo, motivo');

    const r = await dbRun(
      `INSERT INTO atendimentos (paciente_id, profissional_id, agendamento_id, tipo, motivo, anamnese, diagnostico, conduta, observacoes, retorno_em)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [paciente_id, profissional_id, agendamento_id || null, tipo, motivo, anamnese, diagnostico, conduta, observacoes, retorno_em]
    );

    // Atualizar status do agendamento se vinculado
    if (agendamento_id) {
      await dbRun("UPDATE agendamentos SET status='finalizado' WHERE id=?", [agendamento_id]);
    }

    // Alerta de retorno automático
    if (retorno_em) {
      await dbRun(
        `INSERT INTO alertas (tipo, titulo, mensagem, paciente_id, usuario_id)
         VALUES ('retorno', 'Retorno agendado', ?, ?, ?)`,
        [`Retorno do paciente previsto para ${retorno_em}`, paciente_id, profissional_id]
      );
    }

    await registrarLog(req.usuarioId, req.usuarioNome, 'CRIACAO', 'atendimentos', r.lastID, { paciente_id, tipo });
    respOk(res, { id: r.lastID }, 'Atendimento registrado');
  } catch (e) { respErro(res, e.message, 500); }
});

app.put('/api/atendimentos/:id', authMiddleware, async (req, res) => {
  try {
    const { tipo, motivo, anamnese, diagnostico, conduta, observacoes, retorno_em, status } = req.body;
    await dbRun(
      `UPDATE atendimentos SET tipo=COALESCE(?,tipo), motivo=COALESCE(?,motivo), anamnese=?,
       diagnostico=?, conduta=?, observacoes=?, retorno_em=?, status=COALESCE(?,status),
       atualizado_em=datetime('now','localtime') WHERE id=?`,
      [tipo, motivo, anamnese, diagnostico, conduta, observacoes, retorno_em, status, req.params.id]
    );
    await registrarLog(req.usuarioId, req.usuarioNome, 'EDICAO', 'atendimentos', req.params.id);
    respOk(res, null, 'Atendimento atualizado');
  } catch (e) { respErro(res, e.message, 500); }
});

app.delete('/api/atendimentos/:id', authMiddleware, requirePerfil('admin'), async (req, res) => {
  try {
    await dbRun("UPDATE atendimentos SET status='cancelado' WHERE id=?", [req.params.id]);
    await registrarLog(req.usuarioId, req.usuarioNome, 'EXCLUSAO', 'atendimentos', req.params.id);
    respOk(res, null, 'Atendimento cancelado');
  } catch (e) { respErro(res, e.message, 500); }
});

// ─── ROTAS: ANEXOS ────────────────────────────────────────────────────────────

app.post('/api/atendimentos/:id/anexos', authMiddleware, upload.array('arquivos', 10), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.files || req.files.length === 0) return respErro(res, 'Nenhum arquivo enviado');
    const inseridos = [];
    for (const file of req.files) {
      const r = await dbRun(
        'INSERT INTO anexos (atendimento_id, nome_original, nome_arquivo, tipo_mime, tamanho_bytes, descricao) VALUES (?,?,?,?,?,?)',
        [id, file.originalname, file.filename, file.mimetype, file.size, req.body.descricao || null]
      );
      inseridos.push({ id: r.lastID, nome: file.originalname, arquivo: file.filename });
    }
    await registrarLog(req.usuarioId, req.usuarioNome, 'UPLOAD', 'anexos', id, { arquivos: inseridos.length });
    respOk(res, inseridos, 'Arquivos anexados');
  } catch (e) { respErro(res, e.message, 500); }
});

app.delete('/api/anexos/:id', authMiddleware, async (req, res) => {
  try {
    const anexo = await dbGet('SELECT * FROM anexos WHERE id=?', [req.params.id]);
    if (!anexo) return respErro(res, 'Anexo não encontrado', 404);
    const filePath = path.join(UPLOADS_DIR, anexo.nome_arquivo);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await dbRun('DELETE FROM anexos WHERE id=?', [req.params.id]);
    await registrarLog(req.usuarioId, req.usuarioNome, 'EXCLUSAO', 'anexos', req.params.id);
    respOk(res, null, 'Anexo removido');
  } catch (e) { respErro(res, e.message, 500); }
});

// ─── ROTAS: DASHBOARD ────────────────────────────────────────────────────────

app.get('/api/dashboard', authMiddleware, async (req, res) => {
  try {
    const hoje = new Date().toISOString().slice(0, 10);
    const [
      totalPacientes,
      agendHoje,
      atendHoje,
      agendStatus,
      proximosAgend,
      alertasPendentes,
      atendSemana,
      profissionaisAtivos
    ] = await Promise.all([
      dbGet("SELECT COUNT(*) as n FROM pacientes WHERE ativo=1"),
      dbGet("SELECT COUNT(*) as n FROM agendamentos WHERE DATE(data_hora)=? AND status NOT IN ('cancelado','faltou')", [hoje]),
      dbGet("SELECT COUNT(*) as n FROM atendimentos WHERE DATE(data_hora)=?", [hoje]),
      dbAll(`SELECT status, COUNT(*) as n FROM agendamentos WHERE DATE(data_hora)=? GROUP BY status`, [hoje]),
      dbAll(`
        SELECT ag.*, p.nome as paciente_nome, u.nome as profissional_nome
        FROM agendamentos ag JOIN pacientes p ON p.id=ag.paciente_id JOIN usuarios u ON u.id=ag.profissional_id
        WHERE DATE(ag.data_hora)=? AND ag.status IN ('agendado','confirmado')
        ORDER BY ag.data_hora LIMIT 8
      `, [hoje]),
      dbGet("SELECT COUNT(*) as n FROM alertas WHERE lido=0"),
      dbGet(`SELECT COUNT(*) as n FROM atendimentos WHERE DATE(data_hora) BETWEEN DATE(?,'weekday 0','-7 days') AND ?`, [hoje, hoje]),
      dbGet("SELECT COUNT(*) as n FROM usuarios WHERE perfil='profissional' AND ativo=1"),
    ]);

    respOk(res, {
      total_pacientes: totalPacientes.n,
      agend_hoje: agendHoje.n,
      atend_hoje: atendHoje.n,
      agend_status: agendStatus,
      proximos_agendamentos: proximosAgend,
      alertas_pendentes: alertasPendentes.n,
      atend_semana: atendSemana.n,
      profissionais_ativos: profissionaisAtivos.n
    });
  } catch (e) { respErro(res, e.message, 500); }
});

// ─── ROTAS: ALERTAS ───────────────────────────────────────────────────────────

app.get('/api/alertas', authMiddleware, async (req, res) => {
  try {
    const rows = await dbAll(`
      SELECT al.*, p.nome as paciente_nome
      FROM alertas al LEFT JOIN pacientes p ON p.id=al.paciente_id
      WHERE (al.usuario_id=? OR al.usuario_id IS NULL)
      ORDER BY al.criado_em DESC LIMIT 50
    `, [req.usuarioId]);
    respOk(res, rows);
  } catch (e) { respErro(res, e.message, 500); }
});

app.put('/api/alertas/:id/lido', authMiddleware, async (req, res) => {
  try {
    await dbRun('UPDATE alertas SET lido=1 WHERE id=?', [req.params.id]);
    respOk(res, null, 'Marcado como lido');
  } catch (e) { respErro(res, e.message, 500); }
});

app.put('/api/alertas/lidos/todos', authMiddleware, async (req, res) => {
  try {
    await dbRun('UPDATE alertas SET lido=1 WHERE usuario_id=? OR usuario_id IS NULL', [req.usuarioId]);
    respOk(res, null, 'Todos marcados como lidos');
  } catch (e) { respErro(res, e.message, 500); }
});

// ─── ROTAS: LOGS ─────────────────────────────────────────────────────────────

app.get('/api/logs', authMiddleware, requirePerfil('admin'), async (req, res) => {
  try {
    const { pagina = 1, limite = 50, entidade, usuario_id } = req.query;
    const offset = (parseInt(pagina) - 1) * parseInt(limite);
    let where = 'WHERE 1=1';
    const params = [];
    if (entidade) { where += ' AND entidade=?'; params.push(entidade); }
    if (usuario_id) { where += ' AND usuario_id=?'; params.push(usuario_id); }
    const rows = await dbAll(
      `SELECT * FROM logs ${where} ORDER BY criado_em DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limite), offset]
    );
    const total = await dbGet(`SELECT COUNT(*) as n FROM logs ${where}`, params);
    respOk(res, { logs: rows, total: total.n });
  } catch (e) { respErro(res, e.message, 500); }
});

// ─── ROTAS: BUSCA GLOBAL ──────────────────────────────────────────────────────

app.get('/api/busca', authMiddleware, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return respOk(res, { pacientes: [], atendimentos: [] });

    const pacientes = await dbAll(
      `SELECT id, nome, cpf, telefone FROM pacientes WHERE ativo=1 AND (nome LIKE ? OR cpf LIKE ? OR telefone LIKE ?) LIMIT 10`,
      [`%${q}%`, `%${q}%`, `%${q}%`]
    );
    const atendimentos = await dbAll(
      `SELECT at.id, at.tipo, at.motivo, at.data_hora, p.nome as paciente_nome
       FROM atendimentos at JOIN pacientes p ON p.id=at.paciente_id
       WHERE (at.motivo LIKE ? OR at.tipo LIKE ? OR p.nome LIKE ?) LIMIT 10`,
      [`%${q}%`, `%${q}%`, `%${q}%`]
    );
    respOk(res, { pacientes, atendimentos });
  } catch (e) { respErro(res, e.message, 500); }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', versao: '1.0.0', timestamp: new Date().toISOString() });
});

// ─── START ────────────────────────────────────────────────────────────────────

initSchema().then(() => {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`[ClinicaDesk] Servidor rodando em http://127.0.0.1:${PORT}`);
  });
}).catch(err => {
  console.error('[ClinicaDesk] Erro ao inicializar:', err);
  process.exit(1);
});
