const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dataDir = process.env.SQLITE_DATA_DIR
  ? path.resolve(process.env.SQLITE_DATA_DIR)
  : path.resolve(__dirname, '.data');

const dbPath = process.env.SQLITE_DB_PATH
  ? path.resolve(process.env.SQLITE_DB_PATH)
  : path.resolve(dataDir, 'lavanderia.db');

try {
  fs.mkdirSync(dataDir, { recursive: true });
} catch (err) {
  console.error('Error creating SQLite data directory:', err?.message ?? String(err));
}

try {
  if (fs.existsSync(dbPath)) {
    fs.accessSync(dbPath, fs.constants.W_OK);
  }
} catch (err) {
  try {
    fs.chmodSync(dbPath, 0o666);
    fs.chmodSync(dataDir, 0o777);
  } catch (chmodErr) {
    console.error('SQLite database is not writable:', dbPath);
    console.error('Error:', chmodErr?.message ?? String(chmodErr));
  }
}

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
  if (err) {
    console.error('Error connecting to the database:', err.message);
  } else {
    console.log('Connected to the SQLite database.');
    initDb();
  }
});

db.dbPath = dbPath;
db.dataDir = dataDir;

function initDb() {
  db.serialize(() => {
    db.run('PRAGMA foreign_keys = ON');
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA synchronous = NORMAL');
    db.run('PRAGMA busy_timeout = 5000');

    // Drop the table for a fresh start during development
    // db.run(`DROP TABLE IF EXISTS services`);

    db.run(`CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      precio REAL NOT NULL,
      categoria TEXT NOT NULL,
      icono TEXT NOT NULL
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
      fecha_entrega_tz TEXT DEFAULT 'America/Mexico_City'
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
      activo BOOLEAN DEFAULT 1
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
      FOREIGN KEY(asignado_id) REFERENCES ironing_personnel(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS daily_ironing_limits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date_string TEXT NOT NULL UNIQUE,
      max_pieces INTEGER NOT NULL,
      accumulated_pieces INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS daily_ironing_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date_string TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    
    db.run(`CREATE TABLE IF NOT EXISTS sucursales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      direccion TEXT,
      telefono TEXT,
      activa BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
      backup_path TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    const ensureColumn = (table, column, definition, onDone) => {
      db.all(`PRAGMA table_info(${table})`, [], (err, rows) => {
        if (err) {
          console.error(`Error reading schema for ${table}:`, err.message);
          onDone?.(false);
          return;
        }
        const exists = rows.some(r => r?.name === column);
        if (exists) {
          onDone?.(true);
          return;
        }
        db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, [], (alterErr) => {
          if (alterErr) {
            console.error(`Error adding column ${table}.${column}:`, alterErr.message);
            onDone?.(false);
            return;
          }
          onDone?.(true);
        });
      });
    };

    
    ensureColumn('orders', 'sucursal_id', 'INTEGER');
    ensureColumn('ironing_jobs', 'sucursal_id', 'INTEGER');
    ensureColumn('ironing_personnel', 'sucursal_id', 'INTEGER');
    ensureColumn('services', 'sucursal_id', 'INTEGER');
    ensureColumn('daily_ironing_limits', 'sucursal_id', 'INTEGER');
    ensureColumn('app_settings', 'sucursal_id', 'INTEGER');


    ensureColumn('orders', 'fecha_entrega', 'TEXT');
    ensureColumn('orders', 'fecha_entrega_tz', "TEXT DEFAULT 'America/Mexico_City'");
    ensureColumn('ironing_jobs', 'breakdown_json', 'TEXT');
    ensureColumn('ironing_jobs', 'order_id', 'INTEGER', (ok) => {
      if (!ok) return;
      db.run('CREATE UNIQUE INDEX IF NOT EXISTS ironing_jobs_order_id_unique ON ironing_jobs(order_id)');
    });

    ensureColumn('admin_users', 'failed_attempts', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn('admin_users', 'locked_until_ms', 'INTEGER');
    ensureColumn('admin_users', 'is_active', 'INTEGER NOT NULL DEFAULT 1');
    ensureColumn('admin_users', 'role', "TEXT NOT NULL DEFAULT 'admin'");

    // Verify if we have data, if not insert initial records
    db.get('SELECT COUNT(*) as count FROM services', (err, row) => {
      if (err) {
        console.error('Error counting services:', err.message);
        return;
      }
      if (row.count === 0) {
        console.log('Inserting initial mock data into services...');
        const stmt = db.prepare('INSERT INTO services (nombre, precio, categoria, icono) VALUES (?, ?, ?, ?)');
        const MOCK_SERVICIOS = [
          { nombre: 'Camisa', precio: 2.50, categoria: 'Planchado', icono: '👔' },
          { nombre: 'Pantalón', precio: 3.00, categoria: 'Planchado', icono: '👖' },
          { nombre: 'Vestido', precio: 5.00, categoria: 'Lavado', icono: '👗' },
          { nombre: 'Chamarra', precio: 6.50, categoria: 'Lavado en Seco', icono: '🧥' },
          { nombre: 'Ropa de Cama', precio: 10.00, categoria: 'Lavado', icono: '🛏️' },
          { nombre: 'Traje Completo', precio: 15.00, categoria: 'Lavado en Seco', icono: '🕴️' }
        ];

        MOCK_SERVICIOS.forEach((srv) => {
          stmt.run([srv.nombre, srv.precio, srv.categoria, srv.icono]);
        });
        stmt.finalize();
        console.log('Initial data inserted successfully.');
      }
    });
  });
}

process.on('SIGINT', () => {
  db.close(() => process.exit(0));
});

module.exports = db;
