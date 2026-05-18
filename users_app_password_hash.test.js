process.env.DATABASE_URL = '';
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('./index');
const db = require('./database');

const run = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ changes: this.changes, lastID: this.lastID });
    });
  });

const get = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });

describe('users_app password_hash via Admin DB UI API', () => {
  let adminToken;
  let editorToken;
  let sucursalId;
  let adminUserId;

  beforeAll(async () => {
    await new Promise(r => setTimeout(r, 700));

    const adminUsername = `adm_uapp_${Date.now()}`;
    const editorUsername = `ed_uapp_${Date.now()}`;
    const adminPass = 'AdminPass123';
    const editorPass = 'EditorPass123';

    const a = await run(
      `INSERT INTO admin_users (username, password_hash, password_salt, role, is_active) VALUES (?, ?, ?, ?, ?)`,
      [adminUsername, bcrypt.hashSync(adminPass, 12), 'bcrypt', 'admin', true]
    );
    adminUserId = String(a.lastID);

    await run(
      `INSERT INTO admin_users (username, password_hash, password_salt, role, is_active) VALUES (?, ?, ?, ?, ?)`,
      [editorUsername, bcrypt.hashSync(editorPass, 12), 'bcrypt', 'editor', true]
    );

    const adminLogin = await request(app).post('/admin/api/auth/login').send({ username: adminUsername, password: adminPass });
    expect(adminLogin.statusCode).toBe(200);
    adminToken = adminLogin.body.token;

    const editorLogin = await request(app).post('/admin/api/auth/login').send({ username: editorUsername, password: editorPass });
    expect(editorLogin.statusCode).toBe(200);
    editorToken = editorLogin.body.token;

    const s = await run(
      `INSERT INTO sucursales (nombre, direccion, telefono, email, horario_atencion, encargado_nombre, activa) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['Sucursal UAPP', 'Dir', '000', 'uapp@example.com', '9-6', 'Enc', true]
    );
    sucursalId = s.lastID;
  });

  it('rejects creating users_app row if password_hash is not bcrypt', async () => {
    const res = await request(app)
      .post('/admin/api/tables/users_app/rows')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: { username: `u_${Date.now()}`, password_hash: 'plaintext123', email: 'x@y.com', role: 'user', sucursal_id: sucursalId, is_active: true } });
    expect(res.statusCode).toBe(400);
  });

  it('creates users_app with bcrypt hash and does not store plaintext', async () => {
    const plain = 'PlainPass123';
    const hash = bcrypt.hashSync(plain, 12);
    const username = `u_${Date.now()}`;

    const res = await request(app)
      .post('/admin/api/tables/users_app/rows')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: { username, password_hash: hash, email: 'x@y.com', role: 'user', sucursal_id: sucursalId, is_active: true } });
    expect(res.statusCode).toBe(201);

    const stored = await get('SELECT password_hash FROM users_app WHERE username = ?', [username]);
    expect(stored).toBeTruthy();
    expect(stored.password_hash).toBe(hash);
    expect(bcrypt.compareSync(plain, stored.password_hash)).toBe(true);
    expect(String(stored.password_hash).includes(plain)).toBe(false);
  });

  it('does not change password_hash when updating other fields', async () => {
    const plain = 'KeepPass123';
    const hash = bcrypt.hashSync(plain, 12);
    const username = `u_${Date.now()}`;
    const created = await run(
      `INSERT INTO users_app (username, password_hash, email, role, sucursal_id, is_active) VALUES (?, ?, ?, ?, ?, ?)`,
      [username, hash, 'a@b.com', 'user', sucursalId, true]
    );

    const before = await get('SELECT password_hash FROM users_app WHERE id = ?', [created.lastID]);
    const res = await request(app)
      .patch(`/admin/api/tables/users_app/rows/${encodeURIComponent(created.lastID)}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: { email: 'new@b.com' } });
    expect(res.statusCode).toBe(200);
    const after = await get('SELECT password_hash FROM users_app WHERE id = ?', [created.lastID]);
    expect(after.password_hash).toBe(before.password_hash);
  });

  it('is only accessible by admin users', async () => {
    const hash = bcrypt.hashSync('AnyPass123', 12);
    const res = await request(app)
      .post('/admin/api/tables/users_app/rows')
      .set('Authorization', `Bearer ${editorToken}`)
      .send({ data: { username: `u_${Date.now()}`, password_hash: hash, email: 'x@y.com', role: 'user', sucursal_id: sucursalId, is_active: true } });
    expect(res.statusCode).toBe(403);
  });
});
