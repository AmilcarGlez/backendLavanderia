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
  db.get('SELECT * FROM users_app WHERE username = ? AND is_active = 1', [username], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(401).json({ error: 'Credenciales inválidas' });
    if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Credenciales inválidas' });
    const token = jwt.sign({ id: user.id, username: user.username, sucursal_id: user.sucursal_id, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { id: user.id, username: user.username, sucursal_id: user.sucursal_id, role: user.role } });
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


app.use('/admin/api', createAdminRouter(db));

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
  const { cliente, telefono, express, metodo_pago, total, items, fecha_entrega, fecha_entrega_tz, ironing } = req.body;

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

  const fechaEntregaIso = String(fecha_entrega).trim();
  if (!isValidIsoDate(fechaEntregaIso)) {
    res.status(400).json({ error: 'Invalid fecha_entrega. Expected YYYY-MM-DD' });
    return;
  }

  const tz = typeof fecha_entrega_tz === 'string' && fecha_entrega_tz.trim() ? fecha_entrega_tz.trim() : 'America/Mexico_City';

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');

    db.run(
      `INSERT INTO orders (cliente, telefono, express, metodo_pago, total, fecha_entrega, fecha_entrega_tz, sucursal_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [cliente, telefono || '', express ? 1 : 0, metodo_pago, total, fechaEntregaIso, tz, req.user?.sucursal_id],
      function (err) {
        if (err) {
          db.run('ROLLBACK');
          res.status(500).json({ error: err.message });
          return;
        }

        const orderId = this.lastID;

        const stmt = db.prepare('INSERT INTO order_items (order_id, service_id, cantidad, precio_unitario) VALUES (?, ?, ?, ?)');
        items.forEach(item => {
          stmt.run([orderId, item.service_id, item.cantidad, item.precio]);
        });
        stmt.finalize((err) => {
          if (err) {
            db.run('ROLLBACK');
            res.status(500).json({ error: 'Error inserting order items: ' + err.message });
            return;
          }

          const uniqueServiceIds = Array.from(new Set(items.map(i => Number(i.service_id)).filter(n => Number.isFinite(n))));
          if (uniqueServiceIds.length === 0) {
            db.run('COMMIT', (commitErr) => {
              if (commitErr) {
                db.run('ROLLBACK');
                res.status(500).json({ error: commitErr.message });
                return;
              }
              res.status(201).json({ message: 'Order created successfully', orderId });
            });
            return;
          }

          const placeholders = uniqueServiceIds.map(() => '?').join(',');
          db.all(`SELECT id, categoria FROM services WHERE id IN (${placeholders})`, uniqueServiceIds, (catErr, rows) => {
            if (catErr) {
              db.run('ROLLBACK');
              res.status(500).json({ error: catErr.message });
              return;
            }

            const categoryById = new Map(rows.map(r => [Number(r.id), r.categoria]));
            const planchadoQtyFromItems = items.reduce((acc, it) => {
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
                    db.run('ROLLBACK');
                    res.status(500).json({ error: jobErr.message });
                    return;
                  }
                  db.run('COMMIT', (commitErr) => {
                    if (commitErr) {
                      db.run('ROLLBACK');
                      res.status(500).json({ error: commitErr.message });
                      return;
                    }
                    res.status(201).json({ message: 'Order created successfully', orderId });
                  });
                }
              );
              return;
            }

            db.run('COMMIT', (commitErr) => {
              if (commitErr) {
                db.run('ROLLBACK');
                res.status(500).json({ error: commitErr.message });
                return;
              }
              res.status(201).json({ message: 'Order created successfully', orderId });
            });
          });
        });
      }
    );
  });
});

// Get all orders
app.get('/orders', (req, res) => {
  db.all('SELECT * FROM orders WHERE sucursal_id = ? ORDER BY id DESC', [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

// Update an order (estado, entregado, metodo_pago)
app.put('/orders/:id', (req, res) => {
  const { id } = req.params;
  const { estado, entregado, metodo_pago, fecha_entrega, fecha_entrega_tz } = req.body;

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

  const hasFechaEntrega = fecha_entrega !== undefined && fecha_entrega !== null && String(fecha_entrega).trim() !== '';
  if (hasFechaEntrega && !isValidIsoDate(String(fecha_entrega).trim())) {
    res.status(400).json({ error: 'Invalid fecha_entrega. Expected YYYY-MM-DD' });
    return;
  }
  
  db.run(
    `UPDATE orders SET 
      estado = COALESCE(?, estado), 
      entregado = COALESCE(?, entregado), 
      metodo_pago = COALESCE(?, metodo_pago),
      fecha_entrega = COALESCE(?, fecha_entrega),
      fecha_entrega_tz = COALESCE(?, fecha_entrega_tz)
     WHERE id = ? AND (sucursal_id = ? OR sucursal_id IS NULL)`,
    [
      estado,
      entregado !== undefined ? (entregado ? 1 : 0) : null,
      metodo_pago,
      hasFechaEntrega ? String(fecha_entrega).trim() : null,
      typeof fecha_entrega_tz === 'string' && fecha_entrega_tz.trim() ? fecha_entrega_tz.trim() : null,
      id, req.user?.sucursal_id
    ],
    function(err) {
      if (err) {
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

// --- APP SETTINGS ENDPOINTS ---

app.get('/settings/:key', (req, res) => {
  const { key } = req.params;
  if (!key || !String(key).trim()) {
    res.status(400).json({ error: 'Missing key' });
    return;
  }
  db.get('SELECT value FROM app_settings WHERE key = ?', [String(key).trim()], (err, row) => {
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
    db.run('DELETE FROM app_settings WHERE key = ?', [normalizedKey], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, deleted: true });
    });
    return;
  }

  db.run(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [normalizedKey, normalizedValue],
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
  let params = [];
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
      if (err.message.includes('UNIQUE constraint failed')) {
         return res.status(400).json({ error: 'Limit already exists for this date' });
      }
      return res.status(500).json({ error: err.message });
    }
    
    db.run('INSERT INTO daily_ironing_audit (date_string, action, details) VALUES (?, ?, ?)',
      [date_string, 'CREATE_LIMIT', `Created limit: ${max_pieces}`]);
      
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
      'UPDATE daily_ironing_limits SET max_pieces = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [max_pieces, id, req.user?.sucursal_id],
      function (updateErr) {
        if (updateErr) return res.status(500).json({ error: updateErr.message });
        
        db.run('INSERT INTO daily_ironing_audit (date_string, action, details) VALUES (?, ?, ?)',
          [row.date_string, 'UPDATE_LIMIT', `Updated limit from ${row.max_pieces} to ${max_pieces}`]);
          
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
      
      db.run('INSERT INTO daily_ironing_audit (date_string, action, details) VALUES (?, ?, ?)',
        [row.date_string, 'DELETE_LIMIT', `Deleted limit: ${row.max_pieces}`]);
        
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
    
    db.get('SELECT * FROM daily_ironing_limits WHERE date_string = ? AND sucursal_id = ?', [date_string], (err, row) => {
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
              db.run('INSERT INTO daily_ironing_audit (date_string, action, details) VALUES (?, ?, ?)', [date_string, 'CREATE_LIMIT_AND_ADD', `Created limit: ${globalLimit} and added ${pieces} pieces.`]);
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

          db.run('INSERT INTO daily_ironing_audit (date_string, action, details) VALUES (?, ?, ?)',
            [date_string, 'ADD_PIECES', `Added ${pieces} pieces. Total: ${newAccumulated}`]);
            
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
  db.all('SELECT * FROM ironing_personnel WHERE sucursal_id = ?', [], (err, rows) => {
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
  db.run(query, [nombre, apellido, documento, tarifa, activo !== undefined ? (activo ? 1 : 0) : 1, req.user?.sucursal_id], function (err) {
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
    [nombre, apellido, documento, tarifa, activo !== undefined ? (activo ? 1 : 0) : null, id, req.user?.sucursal_id],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, changes: this.changes });
    }
  );
});

// --- IRONING JOBS ENDPOINTS ---

app.get('/ironing-jobs', (req, res) => {
  const query = `
    SELECT ij.*, ip.nombre as asignado_nombre, ip.apellido as asignado_apellido 
    FROM ironing_jobs ij 
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
