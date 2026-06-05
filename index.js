require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const JWT_SECRET = process.env.JWT_SECRET || 'secret_key_123';
const cors = require('cors');
const path = require('path');
const db = require('./database');
const { createAdminRouter } = require('./admin');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    const elapsedMs = Date.now() - startedAt;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} (${elapsedMs}ms)`);
  });
  next();
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Faltan credenciales' });
  db.get('SELECT * FROM users_app WHERE username = ? AND is_active = ?', [username, true], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(401).json({ error: 'Credenciales inválidas' });
    if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Credenciales inválidas' });
    const token = jwt.sign({ id: user.id, username: user.username, sucursal_id: user.sucursal_id, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    res.json({
      token,
      user: { id: user.id, username: user.username, sucursal_id: user.sucursal_id, role: user.role, pin: user.pin ?? null }
    });
  });
});

const authMiddleware = (req, res, next) => {
  if (req.path === '/login' || req.path === '/health' || req.path.startsWith('/admin')) {
    return next();
  }
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido' });
  }
};

app.use(authMiddleware);

app.get('/users/me', (req, res) => {
  const uid = req.user?.id;
  if (!uid) return res.status(400).json({ error: 'Missing user id' });
  db.get('SELECT id, username, role, sucursal_id, pin, is_active FROM users_app WHERE id = ?', [uid], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (row.is_active === false || row.is_active === 0) return res.status(403).json({ error: 'Usuario inactivo' });
    res.json({ id: row.id, username: row.username, role: row.role, sucursal_id: row.sucursal_id, pin: row.pin ?? null });
  });
});




const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.username !== 'admin1') {
    return res.status(403).json({ error: 'Acceso denegado: Se requiere ser el usuario administrador principal (admin1)' });
  }
  next();
};

app.post('/sucursales', requireAdmin, (req, res) => {
  const { nombre, direccion, telefono, email, horario_atencion, encargado_nombre, username, password } = req.body;
  if (!nombre || !direccion || !telefono || !email || !horario_atencion || !encargado_nombre || !username || !password) {
    return res.status(400).json({ error: 'Faltan campos obligatorios para registrar la sucursal y usuario' });
  }

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');

    // 1. Verificar si el usuario ya existe
    db.get('SELECT id FROM users_app WHERE username = ?', [username], (err, existingUser) => {
      if (err) {
        db.run('ROLLBACK');
        return res.status(500).json({ error: err.message });
      }
      if (existingUser) {
        db.run('ROLLBACK');
        return res.status(400).json({ error: 'El nombre de usuario ya está en uso' });
      }

      // 2. Insertar Sucursal
      db.run(
        `INSERT INTO sucursales (nombre, direccion, telefono, email, horario_atencion, encargado_nombre) VALUES (?, ?, ?, ?, ?, ?)`,
        [nombre, direccion, telefono, email, horario_atencion, encargado_nombre],
        function (err) {
          if (err) {
            db.run('ROLLBACK');
            return res.status(500).json({ error: err.message });
          }

          const sucursalId = this.lastID;
          const passwordHash = bcrypt.hashSync(password, 10);

          // 3. Insertar Usuario
          db.run(
            `INSERT INTO users_app (username, password_hash, email, role, sucursal_id) VALUES (?, ?, ?, 'user', ?)`,
            [username, passwordHash, email, sucursalId],
            function (err) {
              if (err) {
                db.run('ROLLBACK');
                return res.status(500).json({ error: err.message });
              }

              db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                  db.run('ROLLBACK');
                  return res.status(500).json({ error: commitErr.message });
                }
                res.status(201).json({ message: 'Sucursal y usuario creados exitosamente', sucursalId, userId: this.lastID });
              });
            }
          );
        }
      );
    });
  });
});

app.get('/sucursales', requireAdmin, (req, res) => {
  db.all('SELECT * FROM sucursales ORDER BY id DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/sucursal/me', (req, res) => {
  const sid = req.user?.sucursal_id;
  if (!sid) return res.status(400).json({ error: 'Missing sucursal_id' });
  db.get('SELECT * FROM sucursales WHERE id = ?', [sid], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Sucursal no encontrada' });
    res.json(row);
  });
});

const sanitizeText = (value, maxLen) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const v = value.trim();
  const limit = Number.isFinite(maxLen) ? Math.max(1, maxLen) : 2000;
  return v.length > limit ? v.slice(0, limit) : v;
};

const sanitizeLogoBase64 = (value) => {
  const v = sanitizeText(value, 8_000_000);
  if (!v) return null;
  const isDataUrl = /^data:image\/(png|jpe?g|webp);base64,/.test(v);
  const isRawBase64 = /^[A-Za-z0-9+/=\s]+$/.test(v);
  if (!isDataUrl && !isRawBase64) return null;
  return v.replace(/\s+/g, '');
};

app.put('/sucursal/me', (req, res) => {
  const sid = req.user?.sucursal_id;
  if (!sid) return res.status(400).json({ error: 'Missing sucursal_id' });

  const body = req.body || {};
  const empresa_nombre = sanitizeText(body.empresa_nombre, 200);
  const nombre = sanitizeText(body.nombre, 200);
  const direccion = sanitizeText(body.direccion, 500);
  const telefono = sanitizeText(body.telefono, 60);
  const email = sanitizeText(body.email, 200);
  const horario_atencion = sanitizeText(body.horario_atencion, 200);
  const encargado_nombre = sanitizeText(body.encargado_nombre, 200);
  const rfc = sanitizeText(body.rfc, 20);
  const logo_base64 = sanitizeLogoBase64(body.logo_base64);
  const qr_payload = sanitizeText(body.qr_payload, 2000);
  const ticket_legal_text = sanitizeText(body.ticket_legal_text, 500);

  if (rfc && !/^[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}$/i.test(rfc.replace(/\s+/g, ''))) {
    return res.status(400).json({ error: 'RFC inválido' });
  }

  if (body.logo_base64 !== undefined && body.logo_base64 !== null && !logo_base64) {
    return res.status(400).json({ error: 'Logo inválido (base64)' });
  }

  db.run(
    `UPDATE sucursales SET
      empresa_nombre = COALESCE(?, empresa_nombre),
      nombre = COALESCE(?, nombre),
      direccion = COALESCE(?, direccion),
      telefono = COALESCE(?, telefono),
      email = COALESCE(?, email),
      horario_atencion = COALESCE(?, horario_atencion),
      encargado_nombre = COALESCE(?, encargado_nombre),
      rfc = COALESCE(?, rfc),
      logo_base64 = COALESCE(?, logo_base64),
      qr_payload = COALESCE(?, qr_payload),
      ticket_legal_text = COALESCE(?, ticket_legal_text),
      updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      empresa_nombre,
      nombre,
      direccion,
      telefono,
      email,
      horario_atencion,
      encargado_nombre,
      rfc ? rfc.replace(/\s+/g, '').toUpperCase() : null,
      logo_base64,
      qr_payload,
      ticket_legal_text,
      sid
    ],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, changes: this.changes });
    }
  );
});

app.put('/sucursales/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const {
    empresa_nombre,
    nombre,
    direccion,
    telefono,
    email,
    horario_atencion,
    encargado_nombre,
    rfc,
    logo_base64,
    qr_payload,
    ticket_legal_text
  } = req.body || {};

  db.run(
    `UPDATE sucursales SET
      empresa_nombre = COALESCE(?, empresa_nombre),
      nombre = COALESCE(?, nombre),
      direccion = COALESCE(?, direccion),
      telefono = COALESCE(?, telefono),
      email = COALESCE(?, email),
      horario_atencion = COALESCE(?, horario_atencion),
      encargado_nombre = COALESCE(?, encargado_nombre),
      rfc = COALESCE(?, rfc),
      logo_base64 = COALESCE(?, logo_base64),
      qr_payload = COALESCE(?, qr_payload),
      ticket_legal_text = COALESCE(?, ticket_legal_text),
      updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      empresa_nombre ?? null,
      nombre ?? null,
      direccion ?? null,
      telefono ?? null,
      email ?? null,
      horario_atencion ?? null,
      encargado_nombre ?? null,
      rfc ?? null,
      logo_base64 ?? null,
      qr_payload ?? null,
      ticket_legal_text ?? null,
      id
    ],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, changes: this.changes });
    }
  );
});


app.use('/admin/api', createAdminRouter(db));

app.get('/admin/vendor/bcrypt.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'bcryptjs', 'umd', 'index.js'));
});

app.use('/admin', (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'"
  );
  next();
});

app.use('/admin', express.static(path.join(__dirname, 'admin'), { etag: true, maxAge: '1h' }));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// Get all services
app.get('/services', (req, res) => {
  const query = 'SELECT * FROM services WHERE sucursal_id = ? OR sucursal_id IS NULL';
  db.all(query, [req.user?.sucursal_id], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    // ensure strings properties like id exist to match React Native expected standard (or just handle ids correctly)
    const services = rows.map(r => ({ ...r, id: r.id.toString() }));
    res.json(services);
  });
});

// Add a new service
app.post('/services', (req, res) => {
  const { nombre, precio, categoria, icono } = req.body;
  if (!nombre || precio === undefined || !categoria || !icono) {
    res.status(400).json({ error: 'Missing required fields: nombre, precio, categoria, icono' });
    return;
  }

  const query = 'INSERT INTO services (nombre, precio, categoria, icono, sucursal_id) VALUES (?, ?, ?, ?, ?)';
  db.run(query, [nombre, precio, categoria, icono, req.user?.sucursal_id], function (err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.status(201).json({
      id: this.lastID.toString(),
      nombre,
      precio,
      categoria,
      icono
    });
  });
});

// Update a service
app.patch('/services/:id', (req, res) => {
  const { id } = req.params;
  const { nombre, precio, categoria, icono } = req.body;
  
  db.run(
    `UPDATE services SET 
      nombre = COALESCE(?, nombre), 
      precio = COALESCE(?, precio), 
      categoria = COALESCE(?, categoria), 
      icono = COALESCE(?, icono) 
     WHERE id = ? AND (sucursal_id = ? OR sucursal_id IS NULL)`,
    [
      nombre !== undefined ? nombre : null, 
      precio !== undefined ? precio : null, 
      categoria !== undefined ? categoria : null, 
      icono !== undefined ? icono : null, 
      id, req.user?.sucursal_id
    ],
    function(err) {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      res.json({ success: true, changes: this.changes });
    }
  );
});

// Delete a service
app.delete('/services/:id', (req, res) => {
  const { id } = req.params;
  const query = 'DELETE FROM services WHERE id = ? AND (sucursal_id = ? OR sucursal_id IS NULL)';
  db.run(query, [id, req.user?.sucursal_id], function (err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ message: 'Service deleted successfully', changes: this.changes });
  });
});

// Create an order
app.post('/orders', (req, res) => {
  const { cliente, telefono, observaciones, express, metodo_pago, total, anticipo, items, fecha_entrega, fecha_entrega_tz, ironing } = req.body;

  const isValidIsoDate = (value) => {
    if (typeof value !== 'string') return false;
    const v = value.trim();
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return false;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return false;
    const d = new Date(Date.UTC(year, month - 1, day));
    return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
  };

  if (!cliente || express === undefined || !metodo_pago || total === undefined || !items || !items.length || !fecha_entrega) {
    res.status(400).json({ error: 'Missing required fields for order' });
    return;
  }

  const totalNum = Number(total);
  if (!Number.isFinite(totalNum) || totalNum < 0) {
    res.status(400).json({ error: 'Invalid total' });
    return;
  }

  const anticipoNum = anticipo === undefined || anticipo === null || anticipo === '' ? 0 : Number(anticipo);
  if (!Number.isFinite(anticipoNum) || anticipoNum < 0) {
    res.status(400).json({ error: 'Invalid anticipo' });
    return;
  }

  const fechaEntregaIso = String(fecha_entrega).trim();
  if (!isValidIsoDate(fechaEntregaIso)) {
    res.status(400).json({ error: 'Invalid fecha_entrega. Expected YYYY-MM-DD' });
    return;
  }

  const tz = typeof fecha_entrega_tz === 'string' && fecha_entrega_tz.trim() ? fecha_entrega_tz.trim() : 'America/Mexico_City';
  const observacionesText = sanitizeText(observaciones, 2000);

  const normalizedItems = Array.isArray(items)
    ? items.map((item) => {
        const service_id = Number(item?.service_id);
        const cantidad = Number(item?.cantidad);
        const precio = Number(item?.precio);
        return { service_id, cantidad, precio };
      })
    : [];

  const invalidItem = normalizedItems.find((it) => {
    if (!Number.isFinite(it.service_id) || it.service_id <= 0) return true;
    if (!Number.isFinite(it.cantidad) || it.cantidad <= 0) return true;
    if (!Number.isFinite(it.precio) || it.precio < 0) return true;
    if (it.cantidad > 10000) return true;
    return false;
  });
  if (invalidItem) {
    res.status(400).json({ error: 'Invalid items payload' });
    return;
  }

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');

    let finished = false;
    const rollbackAndRespond = (status, message) => {
      if (finished) return;
      finished = true;
      db.run('ROLLBACK', () => {
        res.status(status).json({ error: message });
      });
    };

    db.run(
      `INSERT INTO orders (cliente, telefono, observaciones, express, metodo_pago, total, anticipo, fecha_entrega, fecha_entrega_tz, sucursal_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [cliente, telefono || '', observacionesText, !!express, metodo_pago, totalNum, anticipoNum, fechaEntregaIso, tz, req.user?.sucursal_id],
      function (err) {
        if (err) {
          rollbackAndRespond(500, err.message);
          return;
        }

        const orderId = this.lastID;

        const insertOrderItems = (idx) => {
          if (finished) return;
          if (idx >= normalizedItems.length) return afterOrderItemsInserted();
          const it = normalizedItems[idx];
          db.run(
            'INSERT INTO order_items (order_id, service_id, cantidad, precio_unitario) VALUES (?, ?, ?, ?)',
            [orderId, it.service_id, it.cantidad, it.precio],
            function (itemErr) {
              if (itemErr) {
                rollbackAndRespond(500, 'Error inserting order items: ' + itemErr.message);
                return;
              }
              insertOrderItems(idx + 1);
            }
          );
        };

        const afterOrderItemsInserted = () => {
          const uniqueServiceIds = Array.from(new Set(normalizedItems.map(i => Number(i.service_id)).filter(n => Number.isFinite(n))));
          if (uniqueServiceIds.length === 0) {
            db.run('COMMIT', (commitErr) => {
              if (commitErr) {
                rollbackAndRespond(500, commitErr.message);
                return;
              }
              if (finished) return;
              finished = true;
              res.status(201).json({ message: 'Order created successfully', orderId });
            });
            return;
          }

          const placeholders = uniqueServiceIds.map(() => '?').join(',');
          db.all(`SELECT id, categoria FROM services WHERE id IN (${placeholders})`, uniqueServiceIds, (catErr, rows) => {
            if (catErr) {
              rollbackAndRespond(500, catErr.message);
              return;
            }

            const categoryById = new Map(rows.map(r => [Number(r.id), r.categoria]));
            const planchadoQtyFromItems = normalizedItems.reduce((acc, it) => {
              const sid = Number(it.service_id);
              const qty = Number(it.cantidad);
              if (!Number.isFinite(sid) || !Number.isFinite(qty)) return acc;
              if (categoryById.get(sid) === 'Planchado') return acc + qty;
              return acc;
            }, 0);

            const ironingPiecesTotal = Number(ironing?.pieces_total);
            const planchadoQty = Number.isFinite(ironingPiecesTotal) && ironingPiecesTotal > 0 ? ironingPiecesTotal : planchadoQtyFromItems;

            const breakdownJson =
              ironing && Array.isArray(ironing.breakdown)
                ? JSON.stringify({
                    pieces_total: planchadoQty,
                    breakdown: ironing.breakdown,
                    generated_at_iso: typeof ironing.generated_at_iso === 'string' ? ironing.generated_at_iso : undefined
                  })
                : null;

            if (planchadoQty > 0) {
              db.run(
                `INSERT INTO ironing_jobs (order_id, nombre_cliente, cantidad, fecha_entrega, status, breakdown_json, sucursal_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(order_id) DO UPDATE SET
                   nombre_cliente = excluded.nombre_cliente,
                   cantidad = excluded.cantidad,
                   fecha_entrega = excluded.fecha_entrega,
                   breakdown_json = excluded.breakdown_json`,
                [orderId, cliente, planchadoQty, fechaEntregaIso, 'En Espera', breakdownJson, req.user?.sucursal_id],
                (jobErr) => {
                  if (jobErr) {
                    rollbackAndRespond(500, jobErr.message);
                    return;
                  }
                  db.run('COMMIT', (commitErr) => {
                    if (commitErr) {
                      rollbackAndRespond(500, commitErr.message);
                      return;
                    }
                    if (finished) return;
                    finished = true;
                    res.status(201).json({ message: 'Order created successfully', orderId });
                  });
                }
              );
              return;
            }

            db.run('COMMIT', (commitErr) => {
              if (commitErr) {
                rollbackAndRespond(500, commitErr.message);
                return;
              }
              if (finished) return;
              finished = true;
              res.status(201).json({ message: 'Order created successfully', orderId });
            });
          });
        };

        insertOrderItems(0);
      }
    );
  });
});

const isValidIsoDateQuery = (value) => {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
};

const resolvePaymentBucket = (metodoPago) => {
  const m = String(metodoPago ?? '').trim();
  if (!m) return '';
  if (m.startsWith('Crédito (Pagado: Efectivo)')) return 'Efectivo';
  if (m.startsWith('Crédito (Pagado: Tarjeta)')) return 'Tarjeta';
  if (m.startsWith('Efectivo')) return 'Efectivo';
  if (m.startsWith('Tarjeta')) return 'Tarjeta';
  if (m.startsWith('Crédito')) return 'Crédito';
  return m;
};

const normalizePaymentFilter = (value) => {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v || v === 'all') return null;
  if (v === 'efectivo') return 'Efectivo';
  if (v === 'tarjeta') return 'Tarjeta';
  if (v === 'credito' || v === 'crédito') return 'Crédito';
  return null;
};

app.get('/sales', (req, res) => {
  const start = String(req.query.start ?? '').trim();
  const end = String(req.query.end ?? '').trim();
  const payment = normalizePaymentFilter(req.query.payment);

  if (!start || !end) {
    return res.status(400).json({ error: 'Missing start/end. Expected YYYY-MM-DD' });
  }
  if (!isValidIsoDateQuery(start) || !isValidIsoDateQuery(end)) {
    return res.status(400).json({ error: 'Invalid start/end. Expected YYYY-MM-DD' });
  }

  const dateExpr =
    db.dialect === 'postgres'
      ? `DATE(orders.fecha AT TIME ZONE 'America/Mexico_City')`
      : `DATE(orders.fecha)`;

  const where = [`orders.sucursal_id = ?`, `${dateExpr} BETWEEN ? AND ?`];
  const params = [req.user?.sucursal_id, start, end];

  const sql = `SELECT
    orders.id,
    orders.cliente,
    orders.telefono,
    orders.metodo_pago,
    COALESCE(orders.total, 0) as total,
    COALESCE(orders.anticipo, 0) as anticipo,
    COALESCE(orders.liquidacion_monto, 0) as liquidacion_monto,
    orders.fecha
  FROM orders
  WHERE ${where.join(' AND ')}
  ORDER BY orders.fecha DESC, orders.id DESC`;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const list = Array.isArray(rows) ? rows : [];
    const mapped = list
      .map((r) => {
        const bucket = resolvePaymentBucket(r?.metodo_pago);
        const total = Number(r?.total) || 0;
        const anticipo = Number(r?.anticipo) || 0;
        const liquidacion_monto = Number(r?.liquidacion_monto) || 0;
        const full_total = total + anticipo;
        const metodoPagoStr = String(r?.metodo_pago ?? '');

        const isCreditoPagadoEfectivo = metodoPagoStr.startsWith('Crédito (Pagado: Efectivo)');
        const isCreditoPagadoTarjeta = metodoPagoStr.startsWith('Crédito (Pagado: Tarjeta)');

        const total_operacion =
          bucket === 'Crédito'
            ? total
            : isCreditoPagadoEfectivo || isCreditoPagadoTarjeta
              ? (liquidacion_monto > 0 ? liquidacion_monto : total)
              : full_total;

        const efectivo_recibido =
          isCreditoPagadoEfectivo ? total_operacion : bucket === 'Efectivo' ? total_operacion : bucket === 'Crédito' ? anticipo : 0;
        return {
          id: r?.id,
          cliente: r?.cliente ?? '',
          telefono: r?.telefono ?? '',
          metodo_pago: r?.metodo_pago ?? '',
          metodo_pago_resuelto: bucket,
          total,
          anticipo,
          liquidacion_monto,
          total_operacion,
          efectivo_recibido,
          fecha: r?.fecha
        };
      })
      .filter((r) => (payment ? r.metodo_pago_resuelto === payment : true));
    res.json(mapped);
  });
});

app.get('/sales/summary', (req, res) => {
  const start = String(req.query.start ?? '').trim();
  const end = String(req.query.end ?? '').trim();
  if (!start || !end) {
    return res.status(400).json({ error: 'Missing start/end. Expected YYYY-MM-DD' });
  }
  if (!isValidIsoDateQuery(start) || !isValidIsoDateQuery(end)) {
    return res.status(400).json({ error: 'Invalid start/end. Expected YYYY-MM-DD' });
  }

  const dateExpr =
    db.dialect === 'postgres'
      ? `DATE(orders.fecha AT TIME ZONE 'America/Mexico_City')`
      : `DATE(orders.fecha)`;

  const sql = `SELECT
    COUNT(*) as total_transacciones,
    SUM(
      CASE
        WHEN orders.metodo_pago LIKE 'Efectivo%' THEN (COALESCE(orders.total,0) + COALESCE(orders.anticipo,0))
        WHEN orders.metodo_pago LIKE 'Tarjeta%' THEN (COALESCE(orders.total,0) + COALESCE(orders.anticipo,0))
        WHEN orders.metodo_pago LIKE 'Crédito (Pagado: Efectivo)%' THEN (COALESCE(orders.total,0) + COALESCE(orders.anticipo,0))
        WHEN orders.metodo_pago LIKE 'Crédito (Pagado: Tarjeta)%' THEN (COALESCE(orders.total,0) + COALESCE(orders.anticipo,0))
        WHEN orders.metodo_pago LIKE 'Crédito%' THEN (COALESCE(orders.total,0) + COALESCE(orders.anticipo,0))
        ELSE 0
      END
    ) as ingresos_totales,
    SUM(CASE
      WHEN orders.metodo_pago LIKE 'Crédito (Pagado: Efectivo)%' THEN (COALESCE(orders.anticipo,0) + COALESCE(NULLIF(orders.liquidacion_monto,0), COALESCE(orders.total,0), 0))
      WHEN orders.metodo_pago LIKE 'Efectivo%' THEN (COALESCE(orders.total,0) + COALESCE(orders.anticipo,0))
      WHEN orders.metodo_pago LIKE 'Crédito%' THEN COALESCE(orders.anticipo,0)
      ELSE 0
    END) as efectivo_caja,
    SUM(CASE
      WHEN orders.metodo_pago LIKE 'Crédito (Pagado: Efectivo)%' THEN (COALESCE(orders.anticipo,0) + COALESCE(NULLIF(orders.liquidacion_monto,0), COALESCE(orders.total,0), 0))
      WHEN orders.metodo_pago LIKE 'Efectivo%' THEN (COALESCE(orders.total,0) + COALESCE(orders.anticipo,0))
      WHEN orders.metodo_pago LIKE 'Crédito%' THEN COALESCE(orders.anticipo,0)
      ELSE 0
    END) as efectivo_total,
    SUM(CASE
      WHEN orders.metodo_pago LIKE 'Crédito (Pagado: Tarjeta)%' THEN COALESCE(NULLIF(orders.liquidacion_monto,0), COALESCE(orders.total,0), 0)
      WHEN orders.metodo_pago LIKE 'Tarjeta%' THEN (COALESCE(orders.total,0) + COALESCE(orders.anticipo,0))
      ELSE 0
    END) as tarjeta_total,
    SUM(CASE
      WHEN orders.metodo_pago LIKE 'Crédito%' AND orders.metodo_pago NOT LIKE 'Crédito (Pagado:%' THEN COALESCE(orders.total,0)
      ELSE 0
    END) as credito_total,
    SUM(CASE
      WHEN orders.metodo_pago LIKE 'Crédito%' THEN COALESCE(orders.anticipo,0)
      ELSE 0
    END) as anticipos_efectivo
  FROM orders
  WHERE orders.sucursal_id = ?
    AND ${dateExpr} BETWEEN ? AND ?`;

  db.get(sql, [req.user?.sucursal_id, start, end], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    const r = row || {};
    res.json({
      start,
      end,
      total_transacciones: Number(r.total_transacciones) || 0,
      ingresos_totales: Number(r.ingresos_totales) || 0,
      efectivo_caja: Number(r.efectivo_caja) || 0,
      efectivo_total: Number(r.efectivo_total) || 0,
      tarjeta_total: Number(r.tarjeta_total) || 0,
      credito_total: Number(r.credito_total) || 0,
      anticipos_efectivo: Number(r.anticipos_efectivo) || 0
    });
  });
});

// Get all orders
app.get('/orders', (req, res) => {
  db.all('SELECT * FROM orders WHERE sucursal_id = ? ORDER BY id DESC', [req.user?.sucursal_id], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

app.get('/orders/:id', (req, res) => {
  const idNum = Number(req.params.id);
  if (!Number.isFinite(idNum) || idNum <= 0) {
    return res.status(400).json({ error: 'Invalid order id' });
  }

  db.get('SELECT * FROM orders WHERE id = ? AND sucursal_id = ?', [idNum, req.user?.sucursal_id], (err, order) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    db.all(
      `SELECT
        oi.id,
        oi.service_id,
        oi.cantidad,
        oi.precio_unitario,
        s.nombre as service_nombre,
        s.categoria as service_categoria,
        s.icono as service_icono
      FROM order_items oi
      LEFT JOIN services s ON s.id = oi.service_id
      WHERE oi.order_id = ?
      ORDER BY oi.id ASC`,
      [idNum],
      (itemsErr, items) => {
        if (itemsErr) return res.status(500).json({ error: itemsErr.message });
        res.json({ order, items: Array.isArray(items) ? items : [] });
      }
    );
  });
});

// Update an order (estado, entregado, metodo_pago)
app.put('/orders/:id', (req, res) => {
  const { id } = req.params;
  const { estado, entregado, metodo_pago, fecha_entrega, fecha_entrega_tz, liquidacion_monto, fecha_cobro, liquidacion_fecha, liquidado, fecha } = req.body;

  const isValidIsoDate = (value) => {
    if (typeof value !== 'string') return false;
    const v = value.trim();
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return false;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return false;
    const d = new Date(Date.UTC(year, month - 1, day));
    return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
  };

  const isValidIsoDateTime = (value) => {
    if (typeof value !== 'string') return false;
    const v = value.trim();
    if (!v) return false;
    const dt = new Date(v);
    return Number.isFinite(dt.getTime());
  };

  const hasFechaEntrega = fecha_entrega !== undefined && fecha_entrega !== null && String(fecha_entrega).trim() !== '';
  if (hasFechaEntrega && !isValidIsoDate(String(fecha_entrega).trim())) {
    res.status(400).json({ error: 'Invalid fecha_entrega. Expected YYYY-MM-DD' });
    return;
  }

  const hasFechaCobro = fecha_cobro !== undefined && fecha_cobro !== null && String(fecha_cobro).trim() !== '';
  if (hasFechaCobro && !isValidIsoDate(String(fecha_cobro).trim())) {
    res.status(400).json({ error: 'Invalid fecha_cobro. Expected YYYY-MM-DD' });
    return;
  }

  const hasLiquidacionFecha = liquidacion_fecha !== undefined && liquidacion_fecha !== null && String(liquidacion_fecha).trim() !== '';
  if (hasLiquidacionFecha && !isValidIsoDateTime(String(liquidacion_fecha).trim())) {
    res.status(400).json({ error: 'Invalid liquidacion_fecha. Expected ISO 8601 date-time' });
    return;
  }

  const hasFecha = fecha !== undefined && fecha !== null && String(fecha).trim() !== '';
  if (hasFecha && !isValidIsoDateTime(String(fecha).trim())) {
    res.status(400).json({ error: 'Invalid fecha. Expected ISO 8601 date-time' });
    return;
  }

  const hasLiquidacionMonto =
    liquidacion_monto !== undefined && liquidacion_monto !== null && String(liquidacion_monto).trim() !== '';
  const liquidacionMontoNum = hasLiquidacionMonto ? Number(liquidacion_monto) : null;
  if (hasLiquidacionMonto && (!Number.isFinite(liquidacionMontoNum) || liquidacionMontoNum < 0)) {
    res.status(400).json({ error: 'Invalid liquidacion_monto' });
    return;
  }
  
  db.run(
    `UPDATE orders SET 
      estado = COALESCE(?, estado), 
      entregado = COALESCE(?, entregado), 
      metodo_pago = COALESCE(?, metodo_pago),
      liquidacion_monto = COALESCE(?, liquidacion_monto),
      fecha_cobro = COALESCE(?, fecha_cobro),
      liquidacion_fecha = COALESCE(?, liquidacion_fecha),
      liquidado = COALESCE(?, liquidado),
      fecha = COALESCE(?, fecha),
      fecha_entrega = COALESCE(?, fecha_entrega),
      fecha_entrega_tz = COALESCE(?, fecha_entrega_tz)
     WHERE id = ? AND (sucursal_id = ? OR sucursal_id IS NULL)`,
    [
      estado,
      entregado !== undefined ? !!entregado : null,
      metodo_pago,
      hasLiquidacionMonto ? liquidacionMontoNum : null,
      hasFechaCobro ? String(fecha_cobro).trim() : null,
      hasLiquidacionFecha ? String(liquidacion_fecha).trim() : null,
      liquidado !== undefined ? !!liquidado : null,
      hasFecha ? String(fecha).trim() : null,
      hasFechaEntrega ? String(fecha_entrega).trim() : null,
      typeof fecha_entrega_tz === 'string' && fecha_entrega_tz.trim() ? fecha_entrega_tz.trim() : null,
      id, req.user?.sucursal_id
    ],
    function(err) {
      if (err) {
        console.error('[orders:update] db error', {
          id,
          sucursal_id: req.user?.sucursal_id,
          message: err.message,
          body: req.body
        });
        res.status(500).json({ error: err.message });
        return;
      }

      if (!hasFechaEntrega) {
        res.json({ success: true, changes: this.changes });
        return;
      }

      db.run(
        `UPDATE ironing_jobs SET fecha_entrega = ? WHERE order_id = ?`,
        [String(fecha_entrega).trim(), id],
        (jobErr) => {
          if (jobErr) {
            res.status(500).json({ error: jobErr.message });
            return;
          }
          res.json({ success: true, changes: this.changes });
        }
      );
    }
  );
});

app.delete('/orders/:id', (req, res) => {
  const idNum = Number(req.params.id);
  if (!Number.isFinite(idNum) || idNum <= 0) {
    return res.status(400).json({ error: 'Invalid order id' });
  }

  const sid = req.user?.sucursal_id;
  if (!sid) return res.status(400).json({ error: 'Missing sucursal_id' });

  db.get('SELECT * FROM orders WHERE id = ? AND sucursal_id = ?', [idNum, sid], (err, order) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    db.all('SELECT * FROM order_items WHERE order_id = ?', [idNum], (itemsErr, items) => {
      if (itemsErr) return res.status(500).json({ error: itemsErr.message });

      db.get('SELECT * FROM ironing_jobs WHERE order_id = ? AND (sucursal_id = ? OR sucursal_id IS NULL)', [idNum, sid], (jobErr, job) => {
        if (jobErr) return res.status(500).json({ error: jobErr.message });

        const requestIdHeader = req.headers['x-request-id'];
        const requestId = typeof requestIdHeader === 'string' && requestIdHeader.trim()
          ? requestIdHeader.trim()
          : `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        const actorUserId = req.user?.id !== undefined && req.user?.id !== null ? Number(req.user.id) : null;
        const actorUsername = typeof req.user?.username === 'string' ? req.user.username : null;
        const actorRole = typeof req.user?.role === 'string' ? req.user.role : null;
        const ip = String(req.headers['x-forwarded-for'] ?? req.ip ?? '').split(',')[0].trim() || null;
        const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null;
        const beforeJson = JSON.stringify({ order, items: Array.isArray(items) ? items : [], ironing_job: job ?? null });

        const rollback = (statusCode, message) => {
          db.run('ROLLBACK', () => res.status(statusCode).json({ error: message }));
        };

        db.serialize(() => {
          db.run('BEGIN TRANSACTION');

          db.run('DELETE FROM order_items WHERE order_id = ?', [idNum], (delItemsErr) => {
            if (delItemsErr) return rollback(500, delItemsErr.message);

            db.run('DELETE FROM ironing_jobs WHERE order_id = ? AND (sucursal_id = ? OR sucursal_id IS NULL)', [idNum, sid], (delJobErr) => {
              if (delJobErr) return rollback(500, delJobErr.message);

              db.run('DELETE FROM orders WHERE id = ? AND sucursal_id = ?', [idNum, sid], function (delOrderErr) {
                if (delOrderErr) return rollback(500, delOrderErr.message);
                if (!this.changes) return rollback(404, 'Order not found');

                db.run(
                  `INSERT INTO admin_audit_log
                    (request_id, actor_user_id, actor_username, actor_role, action, table_name, record_pk, ip, user_agent, before_json, after_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  [
                    requestId,
                    actorUserId,
                    actorUsername,
                    actorRole,
                    'ORDER_DELETE',
                    'orders',
                    String(idNum),
                    ip,
                    userAgent,
                    beforeJson,
                    null
                  ],
                  (auditErr) => {
                    if (auditErr) return rollback(500, auditErr.message);

                    db.run('COMMIT', (commitErr) => {
                      if (commitErr) return rollback(500, commitErr.message);
                      res.json({ success: true });
                    });
                  }
                );
              });
            });
          });
        });
      });
    });
  });
});

// --- APP SETTINGS ENDPOINTS ---

app.get('/settings/:key', (req, res) => {
  const { key } = req.params;
  if (!key || !String(key).trim()) {
    res.status(400).json({ error: 'Missing key' });
    return;
  }
  db.get('SELECT value FROM app_settings WHERE key = ? AND sucursal_id = ?', [String(key).trim(), req.user?.sucursal_id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ key: String(key).trim(), value: row?.value ?? null });
  });
});

app.put('/settings/:key', (req, res) => {
  const { key } = req.params;
  const { value } = req.body ?? {};
  if (!key || !String(key).trim()) {
    res.status(400).json({ error: 'Missing key' });
    return;
  }
  if (value === undefined) {
    res.status(400).json({ error: 'Missing value' });
    return;
  }

  const normalizedKey = String(key).trim();
  const normalizedValue = value === null ? '' : String(value);

  if (!normalizedValue.trim()) {
    db.run('DELETE FROM app_settings WHERE key = ? AND sucursal_id = ?', [normalizedKey, req.user?.sucursal_id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, deleted: true });
    });
    return;
  }

  db.run(
    `INSERT INTO app_settings (key, sucursal_id, value) VALUES (?, ?, ?)
     ON CONFLICT(key, sucursal_id) DO UPDATE SET value = excluded.value`,
    [normalizedKey, req.user?.sucursal_id, normalizedValue],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, key: normalizedKey, value: normalizedValue });
    }
  );
});

// --- DAILY LIMITS ENDPOINTS ---

app.get('/daily-limits', (req, res) => {
  const { date } = req.query;
  let query = 'SELECT * FROM daily_ironing_limits WHERE sucursal_id = ? ORDER BY date_string DESC';
  let params = [req.user?.sucursal_id];
  if (date) {
    query = 'SELECT * FROM daily_ironing_limits WHERE date_string = ? AND sucursal_id = ?';
    params = [date, req.user?.sucursal_id];
  }
  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/daily-limits', (req, res) => {
  const { date_string, max_pieces } = req.body;
  if (!date_string || max_pieces === undefined) {
    return res.status(400).json({ error: 'Missing required fields: date_string, max_pieces' });
  }

  const query = 'INSERT INTO daily_ironing_limits (date_string, max_pieces, accumulated_pieces, sucursal_id) VALUES (?, ?, 0, ?)';
  db.run(query, [date_string, max_pieces, req.user?.sucursal_id], function (err) {
    if (err) {
      if (String(err.code || '') === '23505' || err.message.includes('UNIQUE constraint failed')) {
         return res.status(400).json({ error: 'Limit already exists for this date' });
      }
      return res.status(500).json({ error: err.message });
    }
    
    db.run('INSERT INTO daily_ironing_audit (date_string, action, details, sucursal_id) VALUES (?, ?, ?, ?)',
      [date_string, 'CREATE_LIMIT', `Created limit: ${max_pieces}`, req.user?.sucursal_id]);
      
    res.status(201).json({
      id: this.lastID,
      date_string,
      max_pieces,
      accumulated_pieces: 0
    });
  });
});

app.put('/daily-limits/:id', (req, res) => {
  const { id } = req.params;
  const { max_pieces } = req.body;
  if (max_pieces === undefined) {
    return res.status(400).json({ error: 'Missing required field: max_pieces' });
  }

  db.get('SELECT * FROM daily_ironing_limits WHERE id = ? AND sucursal_id = ?', [id, req.user?.sucursal_id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Limit not found' });

    db.run(
      'UPDATE daily_ironing_limits SET max_pieces = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND sucursal_id = ?',
      [max_pieces, id, req.user?.sucursal_id],
      function (updateErr) {
        if (updateErr) return res.status(500).json({ error: updateErr.message });
        
        db.run('INSERT INTO daily_ironing_audit (date_string, action, details, sucursal_id) VALUES (?, ?, ?, ?)',
          [row.date_string, 'UPDATE_LIMIT', `Updated limit from ${row.max_pieces} to ${max_pieces}`, req.user?.sucursal_id]);
          
        res.json({ success: true, changes: this.changes });
      }
    );
  });
});

app.delete('/daily-limits/:id', (req, res) => {
  const { id } = req.params;
  
  db.get('SELECT * FROM daily_ironing_limits WHERE id = ? AND sucursal_id = ?', [id, req.user?.sucursal_id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Limit not found' });

    db.run('DELETE FROM daily_ironing_limits WHERE id = ? AND sucursal_id = ?', [id, req.user?.sucursal_id], function (deleteErr) {
      if (deleteErr) return res.status(500).json({ error: deleteErr.message });
      
      db.run('INSERT INTO daily_ironing_audit (date_string, action, details, sucursal_id) VALUES (?, ?, ?, ?)',
        [row.date_string, 'DELETE_LIMIT', `Deleted limit: ${row.max_pieces}`, req.user?.sucursal_id]);
        
      res.json({ success: true, changes: this.changes });
    });
  });
});

// Endpoint to add pieces and check limit
app.post('/daily-limits/add-pieces', (req, res) => {
  const { date_string, pieces } = req.body;
  if (!date_string || pieces === undefined) {
    return res.status(400).json({ error: 'Missing required fields: date_string, pieces' });
  }

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    
    db.get('SELECT * FROM daily_ironing_limits WHERE date_string = ? AND sucursal_id = ?', [date_string, req.user?.sucursal_id], (err, row) => {
      if (err) {
        db.run('ROLLBACK');
        return res.status(500).json({ error: err.message });
      }
      
      if (!row) {
        db.get('SELECT value FROM app_settings WHERE key = ? AND sucursal_id = ?', ['ironing_daily_limit', req.user?.sucursal_id], (settingErr, settingRow) => {
          if (settingErr) {
            db.run('ROLLBACK');
            return res.status(500).json({ error: settingErr.message });
          }
          const globalLimit = settingRow ? Number(settingRow.value) : 0;
          if (!Number.isFinite(globalLimit) || globalLimit <= 0) {
            db.run('ROLLBACK');
            return res.status(404).json({ error: 'No daily limit set for this date and no global limit found' });
          }
          if (pieces > globalLimit) {
            db.run('ROLLBACK');
            return res.status(400).json({ error: 'Excede el límite diario de planchado', limit: globalLimit, accumulated: 0, requested: pieces });
          }
          db.run(
            'INSERT INTO daily_ironing_limits (date_string, max_pieces, accumulated_pieces, sucursal_id) VALUES (?, ?, ?, ?)',
            [date_string, globalLimit, pieces, req.user?.sucursal_id],
            function (insertErr) {
              if (insertErr) {
                db.run('ROLLBACK');
                return res.status(500).json({ error: insertErr.message });
              }
              db.run('INSERT INTO daily_ironing_audit (date_string, action, details, sucursal_id) VALUES (?, ?, ?, ?)', [date_string, 'CREATE_LIMIT_AND_ADD', `Created limit: ${globalLimit} and added ${pieces} pieces.`, req.user?.sucursal_id]);
              db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                  db.run('ROLLBACK');
                  return res.status(500).json({ error: commitErr.message });
                }
                res.json({ success: true, accumulated_pieces: pieces });
              });
            }
          );
        });
        return;
      }

      if (row.accumulated_pieces + pieces > row.max_pieces) {
        db.run('ROLLBACK');
        return res.status(400).json({ 
          error: 'Excede el límite diario de planchado', 
          limit: row.max_pieces, 
          accumulated: row.accumulated_pieces, 
          requested: pieces 
        });
      }

      const newAccumulated = row.accumulated_pieces + pieces;
      db.run(
        'UPDATE daily_ironing_limits SET accumulated_pieces = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND sucursal_id = ?',
        [newAccumulated, row.id, req.user?.sucursal_id],
        (updateErr) => {
          if (updateErr) {
            db.run('ROLLBACK');
            return res.status(500).json({ error: updateErr.message });
          }

          db.run('INSERT INTO daily_ironing_audit (date_string, action, details, sucursal_id) VALUES (?, ?, ?, ?)',
            [date_string, 'ADD_PIECES', `Added ${pieces} pieces. Total: ${newAccumulated}`, req.user?.sucursal_id]);
            
          db.run('COMMIT', (commitErr) => {
            if (commitErr) {
              db.run('ROLLBACK');
              return res.status(500).json({ error: commitErr.message });
            }
            res.json({ success: true, accumulated_pieces: newAccumulated });
          });
        }
      );
    });
  });
});

// --- IRONING PERSONNEL ENDPOINTS ---

app.get('/ironing-personnel', (req, res) => {
  db.all('SELECT * FROM ironing_personnel WHERE sucursal_id = ?', [req.user?.sucursal_id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map(r => ({ ...r, id: r.id.toString(), activo: !!r.activo })));
  });
});

app.post('/ironing-personnel', (req, res) => {
  const { nombre, apellido, documento, tarifa, activo } = req.body;
  if (!nombre || !apellido || !documento || tarifa === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const query = 'INSERT INTO ironing_personnel (nombre, apellido, documento, tarifa, activo, sucursal_id) VALUES (?, ?, ?, ?, ?, ?)';
  db.run(query, [nombre, apellido, documento, tarifa, activo !== undefined ? !!activo : true, req.user?.sucursal_id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ id: this.lastID.toString(), nombre, apellido, documento, tarifa, activo: activo !== undefined ? activo : true });
  });
});

app.put('/ironing-personnel/:id', (req, res) => {
  const { id } = req.params;
  const { nombre, apellido, documento, tarifa, activo } = req.body;

  db.run(
    `UPDATE ironing_personnel SET 
      nombre = COALESCE(?, nombre),
      apellido = COALESCE(?, apellido),
      documento = COALESCE(?, documento),
      tarifa = COALESCE(?, tarifa),
      activo = COALESCE(?, activo)
     WHERE id = ? AND (sucursal_id = ? OR sucursal_id IS NULL)`,
    [nombre, apellido, documento, tarifa, activo !== undefined ? !!activo : null, id, req.user?.sucursal_id],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, changes: this.changes });
    }
  );
});

// --- IRONING JOBS ENDPOINTS ---

app.get('/ironing-jobs', (req, res) => {
  const query = `
    SELECT ij.*, o.observaciones as observaciones, ip.nombre as asignado_nombre, ip.apellido as asignado_apellido 
    FROM ironing_jobs ij
    LEFT JOIN orders o ON o.id = ij.order_id
    LEFT JOIN ironing_personnel ip ON ij.asignado_id = ip.id
    WHERE ij.sucursal_id = ? ORDER BY ij.id DESC
  `;
  db.all(query, [req.user?.sucursal_id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map(r => ({ 
      ...r, 
      id: r.id.toString(), 
      asignado_id: r.asignado_id ? r.asignado_id.toString() : null 
    })));
  });
});

app.post('/ironing-jobs', (req, res) => {
  const { nombre_cliente, cantidad, fecha_entrega } = req.body;
  if (!nombre_cliente || cantidad === undefined || !fecha_entrega) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  db.run(
    'INSERT INTO ironing_jobs (nombre_cliente, cantidad, fecha_entrega, sucursal_id) VALUES (?, ?, ?, ?)',
    [nombre_cliente, cantidad, fecha_entrega, req.user?.sucursal_id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.status(201).json({ id: this.lastID.toString(), nombre_cliente, cantidad, fecha_entrega, status: 'En Espera' });
    }
  );
});

app.put('/ironing-jobs/:id/assign', (req, res) => {
  const { id } = req.params;
  const { asignado_id } = req.body;

  if (!asignado_id) return res.status(400).json({ error: 'Missing asignado_id' });

  // Verify personnel is active
  db.get('SELECT activo FROM ironing_personnel WHERE id = ? AND sucursal_id = ?', [asignado_id, req.user?.sucursal_id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Personnel not found' });
    if (!row.activo) return res.status(400).json({ error: 'Personnel is not active' });

    db.run(
      `UPDATE ironing_jobs SET asignado_id = ?, status = 'En Proceso', fecha_asignacion = CURRENT_TIMESTAMP WHERE id = ? AND (sucursal_id = ? OR sucursal_id IS NULL)`,
      [asignado_id, id, req.user?.sucursal_id],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, changes: this.changes });
      }
    );
  });
});

app.put('/ironing-jobs/:id/complete', (req, res) => {
  const { id } = req.params;

  db.run(
    `UPDATE ironing_jobs SET status = 'Completado', fecha_completado = CURRENT_TIMESTAMP WHERE id = ? AND (sucursal_id = ? OR sucursal_id IS NULL)`,
    [id, req.user?.sucursal_id],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, changes: this.changes });
    }
  );
});

app.get('/ironing-payments', (req, res) => {
  const { start_date, end_date, personnel_id } = req.query;

  let query = `
    SELECT 
      ij.id, ij.nombre_cliente, ij.cantidad, ij.fecha_completado, 
      ip.id as personnel_id, ip.nombre, ip.apellido, ip.tarifa,
      (ij.cantidad * ip.tarifa) as pago_total
    FROM ironing_jobs ij
    JOIN ironing_personnel ip ON ij.asignado_id = ip.id
    WHERE ij.status = 'Completado' AND ij.sucursal_id = ?
  `;
  const params = [req.user?.sucursal_id];

  if (start_date) {
    query += ` AND date(ij.fecha_completado) >= date(?)`;
    params.push(start_date);
  }
  if (end_date) {
    query += ` AND date(ij.fecha_completado) <= date(?)`;
    params.push(end_date);
  }
  if (personnel_id) {
    query += ` AND ij.asignado_id = ?`;
    params.push(personnel_id);
  }

  query += ` ORDER BY ij.fecha_completado DESC`;

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map(r => ({ ...r, id: r.id.toString(), personnel_id: r.personnel_id.toString() })));
  });
});

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on http://0.0.0.0:${PORT}`);
  });
}

module.exports = app;
