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

describe('Admin users password_hash (bcrypt)', () => {
  let adminToken;
  let editorToken;
  let adminId;
  let editorId;

  beforeAll(async () => {
    await new Promise(r => setTimeout(r, 700));
    const adminUsername = `admintest_${Date.now()}`;
    const editorUsername = `editortest_${Date.now()}`;

    const adminPass = 'AdminPass123';
    const editorPass = 'EditorPass123';
    const adminHash = bcrypt.hashSync(adminPass, 12);
    const editorHash = bcrypt.hashSync(editorPass, 12);

    const a = await run(
      `INSERT INTO admin_users (username, password_hash, password_salt, role, is_active) VALUES (?, ?, ?, ?, ?)`,
      [adminUsername, adminHash, 'bcrypt', 'admin', true]
    );
    const b = await run(
      `INSERT INTO admin_users (username, password_hash, password_salt, role, is_active) VALUES (?, ?, ?, ?, ?)`,
      [editorUsername, editorHash, 'bcrypt', 'editor', true]
    );
    adminId = String(a.lastID);
    editorId = String(b.lastID);

    const loginAdmin = await request(app).post('/admin/api/auth/login').send({ username: adminUsername, password: adminPass });
    expect(loginAdmin.statusCode).toBe(200);
    adminToken = loginAdmin.body.token;

    const loginEditor = await request(app).post('/admin/api/auth/login').send({ username: editorUsername, password: editorPass });
    expect(loginEditor.statusCode).toBe(200);
    editorToken = loginEditor.body.token;
  });

  afterAll((done) => {
    done();
  });

  it('does not update password_hash when password is not modified', async () => {
    const before = await get('SELECT password_hash, password_salt FROM admin_users WHERE id = ?', [adminId]);
    expect(before).toBeTruthy();

    const res = await request(app)
      .patch(`/admin/api/users/${encodeURIComponent(adminId)}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'admin', is_active: true });
    expect(res.statusCode).toBe(200);

    const after = await get('SELECT password_hash, password_salt FROM admin_users WHERE id = ?', [adminId]);
    expect(after.password_hash).toBe(before.password_hash);
    expect(after.password_salt).toBe(before.password_salt);
  });

  it('updates password_hash only when password_hash_bcrypt is provided and does not store plaintext', async () => {
    const newPassword = 'NewAdminPass456';
    const newHash = bcrypt.hashSync(newPassword, 12);

    const res = await request(app)
      .patch(`/admin/api/users/${encodeURIComponent(adminId)}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ password_hash_bcrypt: newHash, role: 'admin', is_active: true });
    expect(res.statusCode).toBe(200);

    const stored = await get('SELECT password_hash, password_salt FROM admin_users WHERE id = ?', [adminId]);
    expect(stored.password_salt).toBe('bcrypt');
    expect(stored.password_hash).toBe(newHash);
    expect(bcrypt.compareSync(newPassword, stored.password_hash)).toBe(true);
    expect(String(stored.password_hash).includes(newPassword)).toBe(false);

    const login = await request(app).post('/admin/api/auth/login').send({ username: (await get('SELECT username FROM admin_users WHERE id = ?', [adminId])).username, password: newPassword });
    expect(login.statusCode).toBe(200);
  });

  it('rejects password management when user is not admin', async () => {
    const res = await request(app)
      .patch(`/admin/api/users/${encodeURIComponent(editorId)}`)
      .set('Authorization', `Bearer ${editorToken}`)
      .send({ role: 'viewer' });
    expect(res.statusCode).toBe(403);
  });
});
