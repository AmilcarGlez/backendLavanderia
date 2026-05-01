const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

function base64urlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64urlDecodeToBuffer(input) {
  const s = String(input).replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (s.length % 4)) % 4;
  const padded = s + '='.repeat(padLen);
  return Buffer.from(padded, 'base64');
}

function nowMs() {
  return Date.now();
}

function getJwtSecret() {
  const secret = process.env.ADMIN_JWT_SECRET;
  if (typeof secret === 'string' && secret.trim().length >= 32) return secret.trim();
  return 'dev-insecure-admin-secret-change-me-please-32chars';
}

function signToken(payload, expiresInSeconds) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const exp = Math.floor(Date.now() / 1000) + Number(expiresInSeconds);
  const fullPayload = { ...payload, exp, iat: Math.floor(Date.now() / 1000) };
  const encodedHeader = base64urlEncode(JSON.stringify(header));
  const encodedPayload = base64urlEncode(JSON.stringify(fullPayload));
  const toSign = `${encodedHeader}.${encodedPayload}`;
  const sig = crypto.createHmac('sha256', getJwtSecret()).update(toSign).digest();
  return `${toSign}.${base64urlEncode(sig)}`;
}

function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return { ok: false, error: 'Invalid token' };
  const [encodedHeader, encodedPayload, encodedSig] = parts;
  const toSign = `${encodedHeader}.${encodedPayload}`;
  const expected = crypto.createHmac('sha256', getJwtSecret()).update(toSign).digest();
  const provided = base64urlDecodeToBuffer(encodedSig);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return { ok: false, error: 'Invalid signature' };
  }
  let payload;
  try {
    payload = JSON.parse(base64urlDecodeToBuffer(encodedPayload).toString('utf8'));
  } catch {
    return { ok: false, error: 'Invalid payload' };
  }
  const exp = Number(payload?.exp);
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) {
    return { ok: false, error: 'Token expired' };
  }
  return { ok: true, payload };
}

function getAdminDataKey() {
  const raw = process.env.ADMIN_DATA_KEY;
  if (!raw) return null;
  try {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length !== 32) return null;
    return buf;
  } catch {
    return null;
  }
}

function encryptValue(plainText) {
  const key = getAdminDataKey();
  if (!key) return String(plainText ?? '');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plainText ?? ''), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decryptValue(value) {
  const key = getAdminDataKey();
  const s = String(value ?? '');
  if (!key) return s;
  if (!s.startsWith('enc:v1:')) return s;
  const parts = s.split(':');
  if (parts.length !== 5) return s;
  const iv = Buffer.from(parts[2], 'base64');
  const tag = Buffer.from(parts[3], 'base64');
  const data = Buffer.from(parts[4], 'base64');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    return plain;
  } catch {
    return s;
  }
}

function parseEncryptColumns() {
  const raw = process.env.ADMIN_ENCRYPT_COLUMNS;
  const set = new Set();
  if (!raw) return set;
  for (const item of String(raw).split(',')) {
    const v = item.trim();
    if (!v) continue;
    const m = v.match(/^([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)$/);
    if (m) set.add(`${m[1]}.${m[2]}`);
  }
  return set;
}

function pbkdf2Hash(password, saltBase64) {
  const salt = Buffer.from(saltBase64, 'base64');
  const hash = crypto.pbkdf2Sync(String(password), salt, 150000, 32, 'sha256');
  return hash.toString('base64');
}

function makeSalt() {
  return crypto.randomBytes(16).toString('base64');
}

function makeRequestId() {
  return crypto.randomBytes(12).toString('hex');
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

async function ensureInitialAdminUser(db) {
  const row = await dbGet(db, 'SELECT COUNT(*) AS c FROM admin_users');
  if (Number(row?.c || 0) > 0) return;

  const username = (process.env.ADMIN_INITIAL_USER || 'admin').trim();
  const password =
    typeof process.env.ADMIN_INITIAL_PASSWORD === 'string' && process.env.ADMIN_INITIAL_PASSWORD.trim()
      ? process.env.ADMIN_INITIAL_PASSWORD.trim()
      : crypto.randomBytes(12).toString('base64url');

  const salt = makeSalt();
  const passwordHash = pbkdf2Hash(password, salt);
  await dbRun(
    db,
    `INSERT INTO admin_users (username, password_hash, password_salt, role, is_active) VALUES (?, ?, ?, ?, 1)`,
    [username, passwordHash, salt, 'admin']
  );
  console.log(`[ADMIN] Usuario inicial creado: ${username}`);
  console.log(`[ADMIN] Password inicial (cámbiala inmediatamente): ${password}`);
}

async function ensureInitialAdminUserWithRetry(db, attemptsLeft = 20) {
  try {
    await ensureInitialAdminUser(db);
  } catch (err) {
    const msg = err?.message ?? String(err);
    if (attemptsLeft > 0 && /no such table/i.test(msg)) {
      setTimeout(() => ensureInitialAdminUserWithRetry(db, attemptsLeft - 1), 150);
      return;
    }
    console.error('[ADMIN] Error creando usuario inicial:', msg);
  }
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const m = String(auth).match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: 'Unauthorized' });
  const verified = verifyToken(m[1]);
  if (!verified.ok) return res.status(401).json({ error: 'Unauthorized' });
  req.admin = verified.payload;
  next();
}

function requireRole(minRole) {
  const order = { viewer: 1, editor: 2, admin: 3 };
  const min = order[minRole] ?? 3;
  return (req, res, next) => {
    const role = String(req.admin?.role || '');
    if ((order[role] ?? 0) < min) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

function normalizeTableName(name) {
  const n = String(name || '').trim();
  if (!/^[A-Za-z0-9_]+$/.test(n)) return null;
  return n;
}

function normalizeColumnName(name) {
  const n = String(name || '').trim();
  if (!/^[A-Za-z0-9_]+$/.test(n)) return null;
  return n;
}

async function getTables(db) {
  const rows = await dbAll(
    db,
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC`
  );
  return rows.map(r => r.name);
}

async function getTableMeta(db, table) {
  const cols = await dbAll(db, `PRAGMA table_info(${table})`);
  const columns = cols.map(c => ({
    cid: c.cid,
    name: c.name,
    type: c.type,
    notnull: !!c.notnull,
    dflt_value: c.dflt_value,
    pk: Number(c.pk || 0)
  }));
  const pkColumns = columns.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
  const textColumns = columns
    .filter(c => /CHAR|CLOB|TEXT/i.test(String(c.type || '')))
    .map(c => c.name);
  const numericColumns = columns
    .filter(c => /INT|REAL|FLOA|DOUB|NUM/i.test(String(c.type || '')))
    .map(c => c.name);
  const columnSet = new Set(columns.map(c => c.name));
  return { columns, pkColumns, textColumns, numericColumns, columnSet };
}

function parsePagination(body) {
  const pageSizeRaw = body?.pageSize ?? body?.page_size ?? 25;
  const pageRaw = body?.page ?? 1;
  const pageSize = Math.max(1, Math.min(200, Number(pageSizeRaw) || 25));
  const page = Math.max(1, Number(pageRaw) || 1);
  const offset = (page - 1) * pageSize;
  return { page, pageSize, offset };
}

function buildWhere(meta, body) {
  const clauses = [];
  const params = [];

  const filters = Array.isArray(body?.filters) ? body.filters : [];
  for (const f of filters) {
    const column = normalizeColumnName(f?.column);
    if (!column || !meta.columnSet.has(column)) continue;
    const op = String(f?.op || 'eq');

    if (op === 'isNull') {
      clauses.push(`${column} IS NULL`);
      continue;
    }
    if (op === 'isNotNull') {
      clauses.push(`${column} IS NOT NULL`);
      continue;
    }

    if (op === 'in') {
      const arr = Array.isArray(f?.value) ? f.value : [];
      const clean = arr.map(v => v).slice(0, 500);
      if (clean.length === 0) continue;
      clauses.push(`${column} IN (${clean.map(() => '?').join(',')})`);
      params.push(...clean);
      continue;
    }

    if (op === 'between') {
      clauses.push(`${column} BETWEEN ? AND ?`);
      params.push(f?.value ?? null, f?.value2 ?? null);
      continue;
    }

    if (op === 'contains') {
      clauses.push(`${column} LIKE ? ESCAPE '\\'`);
      params.push(`%${String(f?.value ?? '').replace(/[%_\\]/g, '\\$&')}%`);
      continue;
    }
    if (op === 'startsWith') {
      clauses.push(`${column} LIKE ? ESCAPE '\\'`);
      params.push(`${String(f?.value ?? '').replace(/[%_\\]/g, '\\$&')}%`);
      continue;
    }
    if (op === 'endsWith') {
      clauses.push(`${column} LIKE ? ESCAPE '\\'`);
      params.push(`%${String(f?.value ?? '').replace(/[%_\\]/g, '\\$&')}`);
      continue;
    }

    const cmpOps = new Map([
      ['eq', '='],
      ['neq', '<>'],
      ['gt', '>'],
      ['gte', '>='],
      ['lt', '<'],
      ['lte', '<=']
    ]);
    const sqlOp = cmpOps.get(op);
    if (!sqlOp) continue;
    clauses.push(`${column} ${sqlOp} ?`);
    params.push(f?.value ?? null);
  }

  const q = typeof body?.q === 'string' ? body.q.trim() : '';
  if (q && meta.textColumns.length > 0) {
    const escaped = q.replace(/[%_\\]/g, '\\$&');
    clauses.push(`(${meta.textColumns.map(c => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    params.push(...meta.textColumns.map(() => `%${escaped}%`));
  }

  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { whereSql, params };
}

function buildOrderBy(meta, body) {
  const sort = normalizeColumnName(body?.sort?.column ?? body?.sort ?? '');
  const dirRaw = String(body?.sort?.dir ?? body?.dir ?? 'desc').toLowerCase();
  const dir = dirRaw === 'asc' ? 'ASC' : 'DESC';
  if (sort && meta.columnSet.has(sort)) return `ORDER BY ${sort} ${dir}`;
  if (meta.pkColumns.length === 1) return `ORDER BY ${meta.pkColumns[0]} ${dir}`;
  return '';
}

function stringifyPk(meta, row) {
  if (meta.pkColumns.length === 1) return String(row?.[meta.pkColumns[0]]);
  const obj = {};
  for (const k of meta.pkColumns) obj[k] = row?.[k];
  return JSON.stringify(obj);
}

function escapeCsv(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function createBackup(db, requestId, actorUserId, reason) {
  const dbPath = db?.dbPath;
  const dataDir = db?.dataDir;
  if (!dbPath || !dataDir) return null;

  const backupsDir = path.join(dataDir, 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').replace('Z', '');
  const backupPath = path.join(backupsDir, `lavanderia_backup_${ts}.db`);
  const escaped = backupPath.replace(/'/g, "''");

  try {
    await dbRun(db, 'PRAGMA wal_checkpoint(FULL)');
  } catch {}

  try {
    await dbRun(db, `VACUUM INTO '${escaped}'`);
  } catch {
    fs.copyFileSync(dbPath, backupPath);
  }

  await dbRun(db, `INSERT INTO admin_backups (request_id, actor_user_id, reason, backup_path) VALUES (?, ?, ?, ?)`, [
    requestId,
    actorUserId ?? null,
    String(reason || ''),
    backupPath
  ]);
  return backupPath;
}

async function audit(db, entry) {
  await dbRun(
    db,
    `INSERT INTO admin_audit_log
     (request_id, actor_user_id, actor_username, actor_role, action, table_name, record_pk, ip, user_agent, before_json, after_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.request_id ?? null,
      entry.actor_user_id ?? null,
      entry.actor_username ?? null,
      entry.actor_role ?? null,
      entry.action,
      entry.table_name ?? null,
      entry.record_pk ?? null,
      entry.ip ?? null,
      entry.user_agent ?? null,
      entry.before_json ?? null,
      entry.after_json ?? null
    ]
  );
}

function getIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0].trim();
  return req.ip;
}

function applyEncryptionToRow(table, row, encryptColumnsSet, mode) {
  const out = { ...row };
  for (const [k, v] of Object.entries(out)) {
    if (!encryptColumnsSet.has(`${table}.${k}`)) continue;
    out[k] = mode === 'decrypt' ? decryptValue(v) : encryptValue(v);
  }
  return out;
}

function createAdminRouter(db) {
  const router = express.Router();
  const encryptColumnsSet = parseEncryptColumns();
  const loginMaxAttempts = Math.max(1, Number(process.env.ADMIN_MAX_LOGIN_ATTEMPTS || 5));
  const lockMinutes = Math.max(1, Number(process.env.ADMIN_LOCK_MINUTES || 15));
  const tokenTtlSeconds = Math.max(300, Number(process.env.ADMIN_TOKEN_TTL_SECONDS || 8 * 60 * 60));

  ensureInitialAdminUserWithRetry(db);

  router.post('/auth/login', async (req, res) => {
    const requestId = makeRequestId();
    const ip = getIp(req);
    const userAgent = String(req.headers['user-agent'] || '');
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });

    try {
      const user = await dbGet(db, `SELECT * FROM admin_users WHERE username = ?`, [username]);
      if (!user || !user.is_active) {
        await audit(db, {
          request_id: requestId,
          actor_username: username,
          actor_role: null,
          action: 'LOGIN_FAIL',
          ip,
          user_agent: userAgent
        });
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const lockedUntil = Number(user.locked_until_ms || 0);
      if (lockedUntil && lockedUntil > nowMs()) {
        await audit(db, {
          request_id: requestId,
          actor_user_id: user.id,
          actor_username: user.username,
          actor_role: user.role,
          action: 'LOGIN_LOCKED',
          ip,
          user_agent: userAgent
        });
        return res.status(423).json({ error: 'Account locked. Try later.' });
      }

      const hash = pbkdf2Hash(password, user.password_salt);
      const ok =
        Buffer.byteLength(hash) === Buffer.byteLength(user.password_hash) &&
        crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.password_hash));

      if (!ok) {
        const failed = Number(user.failed_attempts || 0) + 1;
        const shouldLock = failed >= loginMaxAttempts;
        const lockedUntilMs = shouldLock ? nowMs() + lockMinutes * 60 * 1000 : null;
        await dbRun(
          db,
          `UPDATE admin_users SET failed_attempts = ?, locked_until_ms = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [failed, lockedUntilMs, user.id]
        );
        await audit(db, {
          request_id: requestId,
          actor_user_id: user.id,
          actor_username: user.username,
          actor_role: user.role,
          action: 'LOGIN_FAIL',
          ip,
          user_agent: userAgent
        });
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      await dbRun(
        db,
        `UPDATE admin_users
         SET failed_attempts = 0, locked_until_ms = NULL, last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [user.id]
      );

      const token = signToken({ sub: String(user.id), username: user.username, role: user.role }, tokenTtlSeconds);
      await audit(db, {
        request_id: requestId,
        actor_user_id: user.id,
        actor_username: user.username,
        actor_role: user.role,
        action: 'LOGIN_OK',
        ip,
        user_agent: userAgent
      });
      res.json({
        token,
        expiresInSeconds: tokenTtlSeconds,
        user: { id: String(user.id), username: user.username, role: user.role }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/auth/me', requireAuth, async (req, res) => {
    res.json({ user: { id: String(req.admin.sub), username: req.admin.username, role: req.admin.role } });
  });

  router.get('/meta/tables', requireAuth, requireRole('viewer'), async (req, res) => {
    const requestId = makeRequestId();
    try {
      const tables = await getTables(db);
      await audit(db, {
        request_id: requestId,
        actor_user_id: Number(req.admin.sub),
        actor_username: req.admin.username,
        actor_role: req.admin.role,
        action: 'LIST_TABLES',
        ip: getIp(req),
        user_agent: String(req.headers['user-agent'] || '')
      });
      res.json({ tables });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/tables/:table/schema', requireAuth, requireRole('viewer'), async (req, res) => {
    const requestId = makeRequestId();
    const table = normalizeTableName(req.params.table);
    if (!table) return res.status(400).json({ error: 'Invalid table' });
    try {
      const tables = await getTables(db);
      if (!tables.includes(table)) return res.status(404).json({ error: 'Table not found' });
      const meta = await getTableMeta(db, table);
      await audit(db, {
        request_id: requestId,
        actor_user_id: Number(req.admin.sub),
        actor_username: req.admin.username,
        actor_role: req.admin.role,
        action: 'GET_SCHEMA',
        table_name: table,
        ip: getIp(req),
        user_agent: String(req.headers['user-agent'] || '')
      });
      res.json(meta);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/tables/:table/query', requireAuth, requireRole('viewer'), async (req, res) => {
    const requestId = makeRequestId();
    const table = normalizeTableName(req.params.table);
    if (!table) return res.status(400).json({ error: 'Invalid table' });
    try {
      const tables = await getTables(db);
      if (!tables.includes(table)) return res.status(404).json({ error: 'Table not found' });
      const meta = await getTableMeta(db, table);
      const { page, pageSize, offset } = parsePagination(req.body);
      const { whereSql, params } = buildWhere(meta, req.body);
      const orderBy = buildOrderBy(meta, req.body);
      const countRow = await dbGet(db, `SELECT COUNT(*) AS total FROM ${table} ${whereSql}`, params);
      const rows = await dbAll(
        db,
        `SELECT * FROM ${table} ${whereSql} ${orderBy} LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
      );
      const decryptedRows = rows.map(r => applyEncryptionToRow(table, r, encryptColumnsSet, 'decrypt'));
      await audit(db, {
        request_id: requestId,
        actor_user_id: Number(req.admin.sub),
        actor_username: req.admin.username,
        actor_role: req.admin.role,
        action: 'LIST_ROWS',
        table_name: table,
        ip: getIp(req),
        user_agent: String(req.headers['user-agent'] || ''),
        after_json: JSON.stringify({ page, pageSize, total: Number(countRow?.total || 0) })
      });
      res.json({ page, pageSize, total: Number(countRow?.total || 0), rows: decryptedRows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/tables/:table/rows', requireAuth, requireRole('editor'), async (req, res) => {
    const requestId = makeRequestId();
    const table = normalizeTableName(req.params.table);
    if (!table) return res.status(400).json({ error: 'Invalid table' });
    const data = req.body?.data && typeof req.body.data === 'object' ? req.body.data : null;
    if (!data) return res.status(400).json({ error: 'Missing data' });

    try {
      const tables = await getTables(db);
      if (!tables.includes(table)) return res.status(404).json({ error: 'Table not found' });
      const meta = await getTableMeta(db, table);
      const input = applyEncryptionToRow(table, data, encryptColumnsSet, 'encrypt');

      const columns = Object.keys(input)
        .map(k => normalizeColumnName(k))
        .filter(k => k && meta.columnSet.has(k));

      const requiredCols = meta.columns
        .filter(c => c.notnull && c.dflt_value === null && c.pk === 0)
        .map(c => c.name);
      for (const rc of requiredCols) {
        if (!columns.includes(rc)) return res.status(400).json({ error: `Missing required field: ${rc}` });
      }

      if (columns.length === 0) return res.status(400).json({ error: 'No valid columns' });

      await createBackup(db, requestId, Number(req.admin.sub), `CREATE ${table}`);

      const placeholders = columns.map(() => '?').join(',');
      const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`;
      const params = columns.map(c => input[c]);
      const result = await dbRun(db, sql, params);

      await audit(db, {
        request_id: requestId,
        actor_user_id: Number(req.admin.sub),
        actor_username: req.admin.username,
        actor_role: req.admin.role,
        action: 'CREATE_ROW',
        table_name: table,
        record_pk: meta.pkColumns.length === 1 ? String(result.lastID) : null,
        ip: getIp(req),
        user_agent: String(req.headers['user-agent'] || ''),
        after_json: JSON.stringify({ ...data, _lastID: result.lastID })
      });

      res.status(201).json({ success: true, lastID: result.lastID });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/tables/:table/rows/:id', requireAuth, requireRole('editor'), async (req, res) => {
    const requestId = makeRequestId();
    const table = normalizeTableName(req.params.table);
    const id = String(req.params.id || '').trim();
    if (!table || !id) return res.status(400).json({ error: 'Invalid request' });
    const data = req.body?.data && typeof req.body.data === 'object' ? req.body.data : null;
    if (!data) return res.status(400).json({ error: 'Missing data' });

    try {
      const tables = await getTables(db);
      if (!tables.includes(table)) return res.status(404).json({ error: 'Table not found' });
      const meta = await getTableMeta(db, table);
      if (meta.pkColumns.length !== 1) return res.status(400).json({ error: 'Table without single primary key not supported' });
      const pk = meta.pkColumns[0];

      const before = await dbGet(db, `SELECT * FROM ${table} WHERE ${pk} = ?`, [id]);
      if (!before) return res.status(404).json({ error: 'Row not found' });

      const input = applyEncryptionToRow(table, data, encryptColumnsSet, 'encrypt');
      const columns = Object.keys(input)
        .map(k => normalizeColumnName(k))
        .filter(k => k && meta.columnSet.has(k) && k !== pk);
      if (columns.length === 0) return res.status(400).json({ error: 'No valid columns' });

      await createBackup(db, requestId, Number(req.admin.sub), `UPDATE ${table} ${pk}=${id}`);

      const setSql = columns.map(c => `${c} = ?`).join(', ');
      const params = [...columns.map(c => input[c]), id];
      const result = await dbRun(db, `UPDATE ${table} SET ${setSql} WHERE ${pk} = ?`, params);

      const after = await dbGet(db, `SELECT * FROM ${table} WHERE ${pk} = ?`, [id]);
      await audit(db, {
        request_id: requestId,
        actor_user_id: Number(req.admin.sub),
        actor_username: req.admin.username,
        actor_role: req.admin.role,
        action: 'UPDATE_ROW',
        table_name: table,
        record_pk: String(id),
        ip: getIp(req),
        user_agent: String(req.headers['user-agent'] || ''),
        before_json: JSON.stringify(applyEncryptionToRow(table, before, encryptColumnsSet, 'decrypt')),
        after_json: JSON.stringify(applyEncryptionToRow(table, after, encryptColumnsSet, 'decrypt'))
      });

      res.json({ success: true, changes: result.changes });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/tables/:table/rows/:id', requireAuth, requireRole('admin'), async (req, res) => {
    const requestId = makeRequestId();
    const table = normalizeTableName(req.params.table);
    const id = String(req.params.id || '').trim();
    if (!table || !id) return res.status(400).json({ error: 'Invalid request' });
    if (String(req.headers['x-confirm-delete'] || '').toLowerCase() !== 'yes') {
      return res.status(400).json({ error: 'Missing delete confirmation header' });
    }

    try {
      const tables = await getTables(db);
      if (!tables.includes(table)) return res.status(404).json({ error: 'Table not found' });
      const meta = await getTableMeta(db, table);
      if (meta.pkColumns.length !== 1) return res.status(400).json({ error: 'Table without single primary key not supported' });
      const pk = meta.pkColumns[0];

      const before = await dbGet(db, `SELECT * FROM ${table} WHERE ${pk} = ?`, [id]);
      if (!before) return res.status(404).json({ error: 'Row not found' });

      await createBackup(db, requestId, Number(req.admin.sub), `DELETE ${table} ${pk}=${id}`);
      const result = await dbRun(db, `DELETE FROM ${table} WHERE ${pk} = ?`, [id]);

      await audit(db, {
        request_id: requestId,
        actor_user_id: Number(req.admin.sub),
        actor_username: req.admin.username,
        actor_role: req.admin.role,
        action: 'DELETE_ROW',
        table_name: table,
        record_pk: String(id),
        ip: getIp(req),
        user_agent: String(req.headers['user-agent'] || ''),
        before_json: JSON.stringify(applyEncryptionToRow(table, before, encryptColumnsSet, 'decrypt'))
      });

      res.json({ success: true, changes: result.changes });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/tables/:table/export', requireAuth, requireRole('viewer'), async (req, res) => {
    const requestId = makeRequestId();
    const table = normalizeTableName(req.params.table);
    const format = String(req.query.format || 'csv').toLowerCase();
    if (!table) return res.status(400).json({ error: 'Invalid table' });
    if (!['csv', 'xlsx', 'pdf'].includes(format)) return res.status(400).json({ error: 'Invalid format' });

    try {
      const tables = await getTables(db);
      if (!tables.includes(table)) return res.status(404).json({ error: 'Table not found' });
      const meta = await getTableMeta(db, table);

      const body = {
        page: 1,
        pageSize: Math.max(1, Math.min(5000, Number(req.query.limit || 1000))),
        sort: req.query.sort ? { column: req.query.sort, dir: req.query.dir } : undefined,
        q: req.query.q,
        filters: (() => {
          if (!req.query.filters) return [];
          try {
            const parsed = JSON.parse(String(req.query.filters));
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })()
      };

      const { whereSql, params } = buildWhere(meta, body);
      const orderBy = buildOrderBy(meta, body);
      const rows = await dbAll(
        db,
        `SELECT * FROM ${table} ${whereSql} ${orderBy} LIMIT ?`,
        [...params, body.pageSize]
      );
      const decryptedRows = rows.map(r => applyEncryptionToRow(table, r, encryptColumnsSet, 'decrypt'));

      await audit(db, {
        request_id: requestId,
        actor_user_id: Number(req.admin.sub),
        actor_username: req.admin.username,
        actor_role: req.admin.role,
        action: 'EXPORT',
        table_name: table,
        ip: getIp(req),
        user_agent: String(req.headers['user-agent'] || ''),
        after_json: JSON.stringify({ format, count: decryptedRows.length })
      });

      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${table}.csv"`);
        const headers = meta.columns.map(c => c.name);
        res.write(headers.map(escapeCsv).join(',') + '\n');
        for (const r of decryptedRows) {
          const line = headers.map(h => escapeCsv(r[h])).join(',');
          res.write(line + '\n');
        }
        res.end();
        return;
      }

      if (format === 'xlsx') {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet(table);
        sheet.columns = meta.columns.map(c => ({ header: c.name, key: c.name, width: 20 }));
        for (const r of decryptedRows) sheet.addRow(r);
        res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader('Content-Disposition', `attachment; filename="${table}.xlsx"`);
        await workbook.xlsx.write(res);
        res.end();
        return;
      }

      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${table}.pdf"`);
      doc.pipe(res);
      doc.fontSize(16).text(`Export: ${table}`, { align: 'left' });
      doc.moveDown();
      doc.fontSize(10);
      const headers = meta.columns.map(c => c.name);
      for (const r of decryptedRows) {
        const line = headers
          .map(h => `${h}: ${r[h] === null || r[h] === undefined ? '' : String(r[h]).slice(0, 120)}`)
          .join('   ');
        doc.text(line);
        doc.moveDown(0.25);
      }
      doc.end();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/audit', requireAuth, requireRole('admin'), async (req, res) => {
    const pageSize = Math.max(1, Math.min(200, Number(req.query.pageSize || 50)));
    const page = Math.max(1, Number(req.query.page || 1));
    const offset = (page - 1) * pageSize;
    const tableName = typeof req.query.table === 'string' ? req.query.table.trim() : '';
    const action = typeof req.query.action === 'string' ? req.query.action.trim() : '';
    const actor = typeof req.query.actor === 'string' ? req.query.actor.trim() : '';
    const clauses = [];
    const params = [];
    if (tableName) {
      clauses.push('table_name = ?');
      params.push(tableName);
    }
    if (action) {
      clauses.push('action = ?');
      params.push(action);
    }
    if (actor) {
      clauses.push('actor_username = ?');
      params.push(actor);
    }
    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    try {
      const countRow = await dbGet(db, `SELECT COUNT(*) AS total FROM admin_audit_log ${whereSql}`, params);
      const rows = await dbAll(
        db,
        `SELECT * FROM admin_audit_log ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
      );
      res.json({ page, pageSize, total: Number(countRow?.total || 0), rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/backups', requireAuth, requireRole('admin'), async (req, res) => {
    const pageSize = Math.max(1, Math.min(200, Number(req.query.pageSize || 50)));
    const page = Math.max(1, Number(req.query.page || 1));
    const offset = (page - 1) * pageSize;
    try {
      const countRow = await dbGet(db, `SELECT COUNT(*) AS total FROM admin_backups`, []);
      const rows = await dbAll(
        db,
        `SELECT * FROM admin_backups ORDER BY id DESC LIMIT ? OFFSET ?`,
        [pageSize, offset]
      );
      res.json({ page, pageSize, total: Number(countRow?.total || 0), rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/users', requireAuth, requireRole('admin'), async (req, res) => {
    try {
      const rows = await dbAll(
        db,
        `SELECT id, username, role, is_active, failed_attempts, locked_until_ms, last_login_at, created_at, updated_at
         FROM admin_users ORDER BY id ASC`
      );
      res.json({ users: rows.map(u => ({ ...u, id: String(u.id) })) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/users', requireAuth, requireRole('admin'), async (req, res) => {
    const requestId = makeRequestId();
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const role = typeof req.body?.role === 'string' ? req.body.role.trim() : 'viewer';
    const isActive = req.body?.is_active === undefined ? 1 : req.body.is_active ? 1 : 0;

    if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });
    if (!['viewer', 'editor', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    try {
      const salt = makeSalt();
      const passwordHash = pbkdf2Hash(password, salt);
      const result = await dbRun(
        db,
        `INSERT INTO admin_users (username, password_hash, password_salt, role, is_active) VALUES (?, ?, ?, ?, ?)`,
        [username, passwordHash, salt, role, isActive]
      );
      await audit(db, {
        request_id: requestId,
        actor_user_id: Number(req.admin.sub),
        actor_username: req.admin.username,
        actor_role: req.admin.role,
        action: 'CREATE_USER',
        record_pk: String(result.lastID),
        ip: getIp(req),
        user_agent: String(req.headers['user-agent'] || ''),
        after_json: JSON.stringify({ id: result.lastID, username, role, is_active: isActive })
      });
      res.status(201).json({ success: true, id: String(result.lastID) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
    const requestId = makeRequestId();
    const userId = String(req.params.id || '').trim();
    if (!userId) return res.status(400).json({ error: 'Invalid user id' });
    const role = req.body?.role !== undefined ? String(req.body.role).trim() : undefined;
    const isActive = req.body?.is_active !== undefined ? (req.body.is_active ? 1 : 0) : undefined;
    const password = req.body?.password !== undefined ? String(req.body.password) : undefined;

    try {
      const before = await dbGet(db, `SELECT * FROM admin_users WHERE id = ?`, [userId]);
      if (!before) return res.status(404).json({ error: 'User not found' });

      const updates = [];
      const params = [];
      if (role !== undefined) {
        if (!['viewer', 'editor', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
        updates.push('role = ?');
        params.push(role);
      }
      if (isActive !== undefined) {
        updates.push('is_active = ?');
        params.push(isActive);
      }
      if (password !== undefined && password.trim()) {
        const salt = makeSalt();
        const passwordHash = pbkdf2Hash(password, salt);
        updates.push('password_hash = ?');
        updates.push('password_salt = ?');
        updates.push('failed_attempts = 0');
        updates.push('locked_until_ms = NULL');
        params.push(passwordHash, salt);
      }
      if (updates.length === 0) return res.status(400).json({ error: 'No changes' });
      updates.push('updated_at = CURRENT_TIMESTAMP');
      params.push(userId);

      const result = await dbRun(db, `UPDATE admin_users SET ${updates.join(', ')} WHERE id = ?`, params);
      const after = await dbGet(db, `SELECT * FROM admin_users WHERE id = ?`, [userId]);
      await audit(db, {
        request_id: requestId,
        actor_user_id: Number(req.admin.sub),
        actor_username: req.admin.username,
        actor_role: req.admin.role,
        action: 'UPDATE_USER',
        record_pk: String(userId),
        ip: getIp(req),
        user_agent: String(req.headers['user-agent'] || ''),
        before_json: JSON.stringify({ id: before.id, username: before.username, role: before.role, is_active: before.is_active }),
        after_json: JSON.stringify({ id: after.id, username: after.username, role: after.role, is_active: after.is_active })
      });
      res.json({ success: true, changes: result.changes });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createAdminRouter };
