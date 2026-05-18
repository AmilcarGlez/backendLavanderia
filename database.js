const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const rawDatabaseUrl = typeof process.env.DATABASE_URL === 'string' ? process.env.DATABASE_URL.trim() : '';
const wantsPostgres =
  !!rawDatabaseUrl &&
  rawDatabaseUrl.startsWith('postgresql://') &&
  !rawDatabaseUrl.includes('<password>') &&
  !rawDatabaseUrl.includes('<user>') &&
  !rawDatabaseUrl.includes('<host>') &&
  !rawDatabaseUrl.includes('<db>');

function loadSqlite3() {
  try {
    return require('sqlite3').verbose();
  } catch (err) {
    const msg = err?.message ?? String(err);
    throw new Error(
      `sqlite3 no está disponible en este entorno. ` +
        `Si estás usando PostgreSQL remota, configura DATABASE_URL y no se cargará sqlite3. ` +
        `Detalle: ${msg}`
    );
  }
}

function replaceQuestionMarks(sql) {
  const s = String(sql);
  let i = 0;
  return s.replace(/\?/g, () => `$${++i}`);
}

class PostgresDb {
  constructor(databaseUrl) {
    this.dialect = 'postgres';
    this.databaseUrl = databaseUrl;
    this.pool = new Pool({
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: false },
      max: Math.max(1, Math.min(20, Number(process.env.PG_POOL_MAX || 10))),
      connectionTimeoutMillis: Math.max(1000, Number(process.env.PG_CONN_TIMEOUT_MS || 8000)),
      idleTimeoutMillis: Math.max(1000, Number(process.env.PG_IDLE_TIMEOUT_MS || 10000))
    });
    this._queue = Promise.resolve();
    this._txn = null;
    this._sqlCache = new Map();
    this._tablesWithId = new Set([
      'services',
      'orders',
      'order_items',
      'ironing_personnel',
      'ironing_jobs',
      'daily_ironing_limits',
      'daily_ironing_audit',
      'sucursales',
      'users_app',
      'admin_users',
      'admin_audit_log',
      'admin_backups'
    ]);
  }

  _convertSql(sql) {
    const s = String(sql);
    const cached = this._sqlCache.get(s);
    if (cached) return cached;
    const converted = replaceQuestionMarks(s);
    this._sqlCache.set(s, converted);
    return converted;
  }

  _normalizeBeginCommitRollback(sql) {
    const s = String(sql).trim().toUpperCase();
    if (s === 'BEGIN TRANSACTION') return 'BEGIN';
    if (s === 'BEGIN') return 'BEGIN';
    if (s === 'COMMIT') return 'COMMIT';
    if (s === 'ROLLBACK') return 'ROLLBACK';
    return null;
  }

  _appendReturningIdIfNeeded(sql) {
    const s = String(sql);
    if (!/^\s*INSERT\s+INTO\s+/i.test(s)) return { sql: s, wantsId: false };
    if (/\bRETURNING\b/i.test(s)) return { sql: s, wantsId: true };
    const m = s.match(/^\s*INSERT\s+INTO\s+([A-Za-z0-9_]+)/i);
    const table = m ? m[1] : null;
    if (!table || !this._tablesWithId.has(table)) return { sql: s, wantsId: false };
    return { sql: `${s} RETURNING id`, wantsId: true };
  }

  _parseArgs(sql, params, cb) {
    if (typeof params === 'function') return { sql, params: [], cb: params };
    return { sql, params: Array.isArray(params) ? params : [], cb: typeof cb === 'function' ? cb : () => {} };
  }

  _runWithClient(client, sql, params, cb) {
    const normalized = this._normalizeBeginCommitRollback(sql);
    const rawSql = normalized || sql;
    const { sql: maybeReturning, wantsId } = this._appendReturningIdIfNeeded(rawSql);
    const convertedSql = this._convertSql(maybeReturning);
    client
      .query(convertedSql, params)
      .then((result) => {
        const ctx = { changes: result.rowCount, lastID: wantsId ? result.rows?.[0]?.id : undefined };
        cb.call(ctx, null);
        if (normalized === 'COMMIT' || normalized === 'ROLLBACK') {
          const txn = this._txn;
          this._txn = null;
          txn?.client?.release?.();
          txn?.resolve?.();
        }
      })
      .catch((err) => {
        cb.call({ changes: 0, lastID: undefined }, err);
        if (normalized === 'COMMIT' || normalized === 'ROLLBACK') {
          const txn = this._txn;
          this._txn = null;
          txn?.client?.release?.();
          txn?.reject?.(err);
        }
      });
  }

  all(sql, params, cb) {
    const a = this._parseArgs(sql, params, cb);
    const client = this._txn?.client;
    if (client) {
      const converted = this._convertSql(a.sql);
      client
        .query(converted, a.params)
        .then((r) => a.cb(null, r.rows))
        .catch((e) => a.cb(e));
      return;
    }
    const converted = this._convertSql(a.sql);
    this.pool
      .query(converted, a.params)
      .then((r) => a.cb(null, r.rows))
      .catch((e) => a.cb(e));
  }

  get(sql, params, cb) {
    const a = this._parseArgs(sql, params, cb);
    this.all(a.sql, a.params, (err, rows) => {
      if (err) return a.cb(err);
      a.cb(null, rows && rows.length ? rows[0] : undefined);
    });
  }

  run(sql, params, cb) {
    const a = this._parseArgs(sql, params, cb);
    const client = this._txn?.client;
    if (client) return this._runWithClient(client, a.sql, a.params, a.cb);
    this.pool
      .connect()
      .then((c) => {
        this._runWithClient(c, a.sql, a.params, function (err) {
          c.release();
          a.cb.call(this, err);
        });
      })
      .catch((err) => a.cb.call({ changes: 0, lastID: undefined }, err));
  }

  prepare(sql) {
    const self = this;
    const statement = {
      run(params, cb) {
        self.run(sql, params, cb);
      },
      finalize(cb) {
        if (typeof cb === 'function') cb(null);
      }
    };
    return statement;
  }

  serialize(fn) {
    this._queue = this._queue.then(
      () =>
        new Promise((resolve, reject) => {
          this.pool
            .connect()
            .then((client) => {
              const txn = { client, resolve, reject };
              this._txn = txn;
              try {
                fn();
              } catch (e) {
                this._txn = null;
                client.release();
                reject(e);
              }
            })
            .catch(reject);
        })
    );
  }

  close(cb) {
    this.pool
      .end()
      .then(() => cb?.())
      .catch(() => cb?.());
  }
}

async function initPostgresSchema(pgDb) {
  const q = (sql) => pgDb.pool.query(sql);

  await q(`CREATE TABLE IF NOT EXISTS sucursales (
    id BIGSERIAL PRIMARY KEY,
    nombre TEXT NOT NULL,
    direccion TEXT,
    telefono TEXT,
    email TEXT,
    horario_atencion TEXT,
    encargado_nombre TEXT,
    empresa_nombre TEXT,
    rfc TEXT,
    logo_base64 TEXT,
    qr_payload TEXT,
    ticket_legal_text TEXT,
    activa BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS users_app (
    id BIGSERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    email TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    sucursal_id BIGINT NOT NULL REFERENCES sucursales(id),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS users_app_sucursal_id_idx ON users_app(sucursal_id)`);

  await q(`CREATE TABLE IF NOT EXISTS services (
    id BIGSERIAL PRIMARY KEY,
    nombre TEXT NOT NULL,
    precio NUMERIC NOT NULL,
    categoria TEXT NOT NULL,
    icono TEXT NOT NULL,
    sucursal_id BIGINT REFERENCES sucursales(id)
  )`);
  await q(`CREATE INDEX IF NOT EXISTS services_sucursal_id_idx ON services(sucursal_id)`);

  await q(`CREATE TABLE IF NOT EXISTS orders (
    id BIGSERIAL PRIMARY KEY,
    cliente TEXT NOT NULL,
    telefono TEXT,
    express BOOLEAN NOT NULL,
    metodo_pago TEXT NOT NULL,
    total NUMERIC NOT NULL,
    estado TEXT DEFAULT 'Enproceso',
    entregado BOOLEAN DEFAULT FALSE,
    fecha TIMESTAMPTZ DEFAULT NOW(),
    fecha_entrega TEXT,
    fecha_entrega_tz TEXT DEFAULT 'America/Mexico_City',
    sucursal_id BIGINT REFERENCES sucursales(id)
  )`);
  await q(`CREATE INDEX IF NOT EXISTS orders_sucursal_id_idx ON orders(sucursal_id)`);

  await q(`CREATE TABLE IF NOT EXISTS order_items (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES orders(id),
    service_id BIGINT NOT NULL REFERENCES services(id),
    cantidad INTEGER NOT NULL,
    precio_unitario NUMERIC NOT NULL
  )`);
  await q(`CREATE INDEX IF NOT EXISTS order_items_order_id_idx ON order_items(order_id)`);

  await q(`CREATE TABLE IF NOT EXISTS ironing_personnel (
    id BIGSERIAL PRIMARY KEY,
    nombre TEXT NOT NULL,
    apellido TEXT NOT NULL,
    documento TEXT NOT NULL UNIQUE,
    tarifa NUMERIC NOT NULL,
    activo BOOLEAN DEFAULT TRUE,
    sucursal_id BIGINT REFERENCES sucursales(id)
  )`);
  await q(`CREATE INDEX IF NOT EXISTS ironing_personnel_sucursal_id_idx ON ironing_personnel(sucursal_id)`);

  await q(`CREATE TABLE IF NOT EXISTS ironing_jobs (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT,
    nombre_cliente TEXT NOT NULL,
    cantidad INTEGER NOT NULL,
    fecha_entrega TEXT NOT NULL,
    asignado_id BIGINT REFERENCES ironing_personnel(id),
    breakdown_json TEXT,
    status TEXT DEFAULT 'En Espera',
    fecha_asignacion TIMESTAMPTZ,
    fecha_completado TIMESTAMPTZ,
    sucursal_id BIGINT REFERENCES sucursales(id)
  )`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS ironing_jobs_order_id_unique ON ironing_jobs(order_id)`);
  await q(`CREATE INDEX IF NOT EXISTS ironing_jobs_sucursal_id_idx ON ironing_jobs(sucursal_id)`);

  await q(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT NOT NULL,
    sucursal_id BIGINT NOT NULL REFERENCES sucursales(id),
    value TEXT,
    PRIMARY KEY (key, sucursal_id)
  )`);

  await q(`CREATE TABLE IF NOT EXISTS daily_ironing_limits (
    id BIGSERIAL PRIMARY KEY,
    date_string TEXT NOT NULL,
    max_pieces INTEGER NOT NULL,
    accumulated_pieces INTEGER DEFAULT 0,
    sucursal_id BIGINT NOT NULL REFERENCES sucursales(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (date_string, sucursal_id)
  )`);
  await q(`CREATE INDEX IF NOT EXISTS daily_ironing_limits_sucursal_id_idx ON daily_ironing_limits(sucursal_id)`);

  await q(`CREATE TABLE IF NOT EXISTS daily_ironing_audit (
    id BIGSERIAL PRIMARY KEY,
    date_string TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT,
    sucursal_id BIGINT REFERENCES sucursales(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS admin_users (
    id BIGSERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until_ms BIGINT,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS admin_audit_log (
    id BIGSERIAL PRIMARY KEY,
    request_id TEXT,
    actor_user_id BIGINT,
    actor_username TEXT,
    actor_role TEXT,
    action TEXT NOT NULL,
    table_name TEXT,
    record_pk TEXT,
    ip TEXT,
    user_agent TEXT,
    before_json TEXT,
    after_json TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS admin_audit_log_created_at_idx ON admin_audit_log(created_at)`);
  await q(`CREATE INDEX IF NOT EXISTS admin_audit_log_table_idx ON admin_audit_log(table_name)`);

  await q(`CREATE TABLE IF NOT EXISTS admin_backups (
    id BIGSERIAL PRIMARY KEY,
    request_id TEXT,
    actor_user_id BIGINT,
    reason TEXT,
    backup_path TEXT,
    backup_json TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  const count = await pgDb.pool.query(`SELECT COUNT(*)::int AS c FROM services`);
  if (Number(count.rows?.[0]?.c || 0) === 0) {
    const mock = [
      { nombre: 'Camisa', precio: 2.5, categoria: 'Planchado', icono: '👔' },
      { nombre: 'Pantalón', precio: 3.0, categoria: 'Planchado', icono: '👖' },
      { nombre: 'Vestido', precio: 5.0, categoria: 'Lavado', icono: '👗' },
      { nombre: 'Chamarra', precio: 6.5, categoria: 'Lavado en Seco', icono: '🧥' },
      { nombre: 'Ropa de Cama', precio: 10.0, categoria: 'Lavado', icono: '🛏️' },
      { nombre: 'Traje Completo', precio: 15.0, categoria: 'Lavado en Seco', icono: '🕴️' }
    ];
    for (const s of mock) {
      await pgDb.pool.query(
        `INSERT INTO services (nombre, precio, categoria, icono) VALUES ($1, $2, $3, $4)`,
        [s.nombre, s.precio, s.categoria, s.icono]
      );
    }
  }
}

function createSqliteDb() {
  const sqlite3 = loadSqlite3();
  const dataDir = process.env.SQLITE_DATA_DIR ? path.resolve(process.env.SQLITE_DATA_DIR) : path.resolve(__dirname, '.data');
  const dbPath = process.env.SQLITE_DB_PATH ? path.resolve(process.env.SQLITE_DB_PATH) : path.resolve(dataDir, 'lavanderia.db');

  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (err) {
    console.error('Error creating SQLite data directory:', err?.message ?? String(err));
  }

  const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
      console.error('Error connecting to the database:', err.message);
    } else {
      console.log('Connected to the SQLite database.');
      initSqliteSchema(db);
    }
  });

  db.dialect = 'sqlite';
  db.dbPath = dbPath;
  db.dataDir = dataDir;

  return db;
}

function initSqliteSchema(db) {
  db.serialize(() => {
    db.run('PRAGMA foreign_keys = ON');
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA synchronous = NORMAL');
    db.run('PRAGMA busy_timeout = 5000');

    db.run(`CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      precio REAL NOT NULL,
      categoria TEXT NOT NULL,
      icono TEXT NOT NULL,
      sucursal_id INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente TEXT NOT NULL,
      telefono TEXT,
      express BOOLEAN NOT NULL,
      metodo_pago TEXT NOT NULL,
      total REAL NOT NULL,
      estado TEXT DEFAULT 'Enproceso',
      entregado BOOLEAN DEFAULT 0,
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
      fecha_entrega TEXT,
      fecha_entrega_tz TEXT DEFAULT 'America/Mexico_City',
      sucursal_id INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      service_id INTEGER NOT NULL,
      cantidad INTEGER NOT NULL,
      precio_unitario REAL NOT NULL,
      FOREIGN KEY(order_id) REFERENCES orders(id),
      FOREIGN KEY(service_id) REFERENCES services(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS ironing_personnel (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      apellido TEXT NOT NULL,
      documento TEXT NOT NULL UNIQUE,
      tarifa REAL NOT NULL,
      activo BOOLEAN DEFAULT 1,
      sucursal_id INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS ironing_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER,
      nombre_cliente TEXT NOT NULL,
      cantidad INTEGER NOT NULL,
      fecha_entrega TEXT NOT NULL,
      asignado_id INTEGER,
      breakdown_json TEXT,
      status TEXT DEFAULT 'En Espera',
      fecha_asignacion DATETIME,
      fecha_completado DATETIME,
      sucursal_id INTEGER,
      FOREIGN KEY(asignado_id) REFERENCES ironing_personnel(id)
    )`);
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS ironing_jobs_order_id_unique ON ironing_jobs(order_id)');

    db.run(`CREATE TABLE IF NOT EXISTS sucursales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      direccion TEXT,
      telefono TEXT,
      email TEXT,
      horario_atencion TEXT,
      encargado_nombre TEXT,
      empresa_nombre TEXT,
      rfc TEXT,
      logo_base64 TEXT,
      qr_payload TEXT,
      ticket_legal_text TEXT,
      activa BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS users_app (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      email TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      sucursal_id INTEGER NOT NULL,
      is_active BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(sucursal_id) REFERENCES sucursales(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT NOT NULL,
      sucursal_id INTEGER NOT NULL,
      value TEXT,
      PRIMARY KEY (key, sucursal_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS daily_ironing_limits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date_string TEXT NOT NULL,
      max_pieces INTEGER NOT NULL,
      accumulated_pieces INTEGER DEFAULT 0,
      sucursal_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(date_string, sucursal_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS daily_ironing_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date_string TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      sucursal_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      is_active INTEGER NOT NULL DEFAULT 1,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until_ms INTEGER,
      last_login_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT,
      actor_user_id INTEGER,
      actor_username TEXT,
      actor_role TEXT,
      action TEXT NOT NULL,
      table_name TEXT,
      record_pk TEXT,
      ip TEXT,
      user_agent TEXT,
      before_json TEXT,
      after_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS admin_audit_log_created_at_idx ON admin_audit_log(created_at)`);
    db.run(`CREATE INDEX IF NOT EXISTS admin_audit_log_table_idx ON admin_audit_log(table_name)`);

    db.run(`CREATE TABLE IF NOT EXISTS admin_backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT,
      actor_user_id INTEGER,
      reason TEXT,
      backup_path TEXT,
      backup_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    const ensureColumn = (table, column, definition) => {
      db.all(`PRAGMA table_info(${table})`, [], (err, rows) => {
        if (err) return;
        const exists = Array.isArray(rows) && rows.some(r => r?.name === column);
        if (exists) return;
        db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, [], () => {});
      });
    };

    ensureColumn('services', 'sucursal_id', 'INTEGER');
    ensureColumn('orders', 'sucursal_id', 'INTEGER');
    ensureColumn('ironing_jobs', 'sucursal_id', 'INTEGER');
    ensureColumn('ironing_personnel', 'sucursal_id', 'INTEGER');

    ensureColumn('sucursales', 'email', 'TEXT');
    ensureColumn('sucursales', 'horario_atencion', 'TEXT');
    ensureColumn('sucursales', 'encargado_nombre', 'TEXT');
    ensureColumn('sucursales', 'empresa_nombre', 'TEXT');
    ensureColumn('sucursales', 'rfc', 'TEXT');
    ensureColumn('sucursales', 'logo_base64', 'TEXT');
    ensureColumn('sucursales', 'qr_payload', 'TEXT');
    ensureColumn('sucursales', 'ticket_legal_text', 'TEXT');
    ensureColumn('sucursales', 'updated_at', 'DATETIME');

    ensureColumn('users_app', 'is_active', 'BOOLEAN DEFAULT 1');
    ensureColumn('users_app', 'updated_at', 'DATETIME');

    ensureColumn('app_settings', 'sucursal_id', 'INTEGER');
    ensureColumn('daily_ironing_limits', 'sucursal_id', 'INTEGER');
    ensureColumn('daily_ironing_audit', 'sucursal_id', 'INTEGER');

    ensureColumn('admin_users', 'failed_attempts', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn('admin_users', 'locked_until_ms', 'INTEGER');
    ensureColumn('admin_users', 'role', "TEXT NOT NULL DEFAULT 'admin'");
    ensureColumn('admin_backups', 'backup_json', 'TEXT');

    db.get('SELECT COUNT(*) as count FROM services', (err, row) => {
      if (err) return;
      if (row.count === 0) {
        const stmt = db.prepare('INSERT INTO services (nombre, precio, categoria, icono) VALUES (?, ?, ?, ?)');
        const mock = [
          { nombre: 'Camisa', precio: 2.5, categoria: 'Planchado', icono: '👔' },
          { nombre: 'Pantalón', precio: 3.0, categoria: 'Planchado', icono: '👖' },
          { nombre: 'Vestido', precio: 5.0, categoria: 'Lavado', icono: '👗' },
          { nombre: 'Chamarra', precio: 6.5, categoria: 'Lavado en Seco', icono: '🧥' },
          { nombre: 'Ropa de Cama', precio: 10.0, categoria: 'Lavado', icono: '🛏️' },
          { nombre: 'Traje Completo', precio: 15.0, categoria: 'Lavado en Seco', icono: '🕴️' }
        ];
        for (const s of mock) stmt.run([s.nombre, s.precio, s.categoria, s.icono]);
        stmt.finalize();
      }
    });
  });
}

const db = wantsPostgres ? new PostgresDb(rawDatabaseUrl) : createSqliteDb();

if (db.dialect === 'postgres') {
  const maxAttempts = Math.max(1, Number(process.env.PG_INIT_ATTEMPTS || 5));
  const delayMs = Math.max(100, Number(process.env.PG_INIT_DELAY_MS || 700));
  const attempt = async (n) => {
    try {
      await initPostgresSchema(db);
      console.log('Connected to PostgreSQL database.');
    } catch (err) {
      if (n >= maxAttempts) {
        console.error('Error initializing PostgreSQL schema:', err?.message ?? String(err));
        return;
      }
      setTimeout(() => attempt(n + 1), delayMs);
    }
  };
  attempt(1);
}

process.on('SIGINT', () => {
  db.close(() => process.exit(0));
});

module.exports = db;
