const el = (id) => document.getElementById(id);

const state = {
  token: null,
  user: null,
  tables: [],
  currentTable: null,
  schema: null,
  rows: [],
  total: 0,
  page: 1,
  pageSize: 25,
  sort: null,
  dir: 'desc',
  q: '',
  filters: [],
  editing: null,
  usersPasswordDirty: new Map()
};

const PASSWORD_POLICY = {
  minLen: 10,
  requireLower: true,
  requireUpper: true,
  requireDigit: true
};

function isBcryptAvailable() {
  return typeof window.bcrypt === 'object' && typeof window.bcrypt.hash === 'function';
}

function passwordComplexityError(password) {
  const p = String(password || '');
  if (p.length < PASSWORD_POLICY.minLen) return `La contraseña debe tener mínimo ${PASSWORD_POLICY.minLen} caracteres`;
  if (PASSWORD_POLICY.requireLower && !/[a-z]/.test(p)) return 'La contraseña debe incluir una letra minúscula';
  if (PASSWORD_POLICY.requireUpper && !/[A-Z]/.test(p)) return 'La contraseña debe incluir una letra mayúscula';
  if (PASSWORD_POLICY.requireDigit && !/[0-9]/.test(p)) return 'La contraseña debe incluir un número';
  return null;
}

async function bcryptHash(password) {
  if (!isBcryptAvailable()) throw new Error('bcrypt no está disponible en el navegador');
  const rounds = 12;
  return await new Promise((resolve, reject) => {
    window.bcrypt.hash(String(password), rounds, (err, hash) => {
      if (err) reject(err);
      else resolve(hash);
    });
  });
}

function formatUsersError(err) {
  if (!err || typeof err !== 'object') return 'Error desconocido';
  if (!('status' in err)) return 'Error de conexión. Verifica tu red y que el servidor esté activo.';
  if (err.status === 401) return 'Sesión expirada. Inicia sesión nuevamente.';
  if (err.status === 403) return 'Permisos insuficientes (se requiere rol admin).';
  if (err.status === 400) return err.message || 'Solicitud inválida.';
  return err.message || `Error ${err.status}`;
}

function setHidden(id, hidden) {
  const node = el(id);
  if (!node) return;
  node.classList.toggle('hidden', !!hidden);
}

function setText(id, text) {
  const node = el(id);
  if (!node) return;
  node.textContent = text;
}

function showError(id, message) {
  const node = el(id);
  if (!node) return;
  if (message) {
    node.textContent = message;
    node.classList.remove('hidden');
  } else {
    node.textContent = '';
    node.classList.add('hidden');
  }
}

function getRoleRank(role) {
  const map = { viewer: 1, editor: 2, admin: 3 };
  return map[String(role || '')] || 0;
}

async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  const res = await fetch(path, { ...options, headers });
  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const body = isJson ? await res.json().catch(() => ({})) : await res.text().catch(() => '');
  if (!res.ok) {
    const msg = isJson ? body?.error || `Error ${res.status}` : `Error ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function saveToken(token) {
  state.token = token;
  if (token) localStorage.setItem('adminToken', token);
  else localStorage.removeItem('adminToken');
}

async function login(username, password) {
  const out = await apiFetch('/admin/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
  saveToken(out.token);
  state.user = out.user;
  updateSessionUi();
}

async function loadMe() {
  const out = await apiFetch('/admin/api/auth/me');
  state.user = out.user;
  updateSessionUi();
}

function updateSessionUi() {
  if (!state.user) {
    setText('sessionInfo', '');
    setHidden('logoutBtn', true);
    setHidden('adminTools', true);
    return;
  }
  setText('sessionInfo', `${state.user.username} (${state.user.role})`);
  setHidden('logoutBtn', false);
  setHidden('adminTools', getRoleRank(state.user.role) < 3);
}

async function loadTables() {
  const out = await apiFetch('/admin/api/meta/tables');
  state.tables = out.tables || [];
  renderTables();
}

function renderTables() {
  const root = el('tablesList');
  root.innerHTML = '';
  for (const t of state.tables) {
    const item = document.createElement('div');
    item.className = `table-item ${state.currentTable === t ? 'active' : ''}`;
    const left = document.createElement('div');
    left.textContent = t;
    const right = document.createElement('div');
    right.style.opacity = '0.6';
    right.style.fontSize = '12px';
    right.textContent = '';
    item.appendChild(left);
    item.appendChild(right);
    item.addEventListener('click', () => selectTable(t));
    root.appendChild(item);
  }
}

async function selectTable(table) {
  state.currentTable = table;
  state.page = 1;
  state.sort = null;
  state.dir = 'desc';
  state.q = '';
  state.filters = [];
  renderTables();
  setText('currentTable', table);
  el('searchInput').value = '';
  renderFilters();
  await loadSchema();
  await queryRows();
}

async function loadSchema() {
  const out = await apiFetch(`/admin/api/tables/${encodeURIComponent(state.currentTable)}/schema`);
  state.schema = out;
  renderFilterColumns();
  updateActionsAvailability();
}

function updateActionsAvailability() {
  const roleRank = getRoleRank(state.user?.role);
  el('addRowBtn').disabled = roleRank < 2;
  el('exportCsvBtn').disabled = roleRank < 1;
  el('exportXlsxBtn').disabled = roleRank < 1;
  el('exportPdfBtn').disabled = roleRank < 1;
}

function renderFilterColumns() {
  const select = el('filterColumn');
  select.innerHTML = '';
  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = 'Columna…';
  select.appendChild(opt0);
  for (const c of state.schema?.columns || []) {
    const opt = document.createElement('option');
    opt.value = c.name;
    opt.textContent = c.name;
    select.appendChild(opt);
  }
}

function renderFilters() {
  const root = el('filtersList');
  root.innerHTML = '';
  for (let i = 0; i < state.filters.length; i++) {
    const f = state.filters[i];
    const chip = document.createElement('div');
    chip.className = 'chip';
    const text = document.createElement('div');
    text.textContent = `${f.column} ${f.op}${f.op === 'isNull' || f.op === 'isNotNull' ? '' : ` ${String(f.value ?? '')}`}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '×';
    btn.addEventListener('click', () => {
      state.filters.splice(i, 1);
      renderFilters();
      queryRows();
    });
    chip.appendChild(text);
    chip.appendChild(btn);
    root.appendChild(chip);
  }
}

async function queryRows() {
  if (!state.currentTable) return;
  const payload = {
    page: state.page,
    pageSize: state.pageSize,
    sort: state.sort ? { column: state.sort, dir: state.dir } : undefined,
    q: state.q,
    filters: state.filters
  };
  const out = await apiFetch(`/admin/api/tables/${encodeURIComponent(state.currentTable)}/query`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  state.rows = out.rows || [];
  state.total = out.total || 0;
  renderGrid();
  renderPager();
}

function renderPager() {
  const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
  el('prevPageBtn').disabled = state.page <= 1;
  el('nextPageBtn').disabled = state.page >= totalPages;
  setText('pageInfo', `Página ${state.page} / ${totalPages} · Total ${state.total}`);
}

function getPkColumn() {
  const pkCols = (state.schema?.pkColumns || []).slice(0);
  return pkCols.length === 1 ? pkCols[0] : null;
}

function renderGrid() {
  const head = el('gridHead');
  const body = el('gridBody');
  head.innerHTML = '';
  body.innerHTML = '';

  if (!state.schema) return;
  const cols = state.schema.columns.map(c => c.name);
  const pk = getPkColumn();
  const roleRank = getRoleRank(state.user?.role);
  const canEdit = roleRank >= 2;
  const canDelete = roleRank >= 3;

  const trh = document.createElement('tr');
  for (const c of cols) {
    const th = document.createElement('th');
    const isSorted = state.sort === c;
    th.textContent = isSorted ? `${c} ${state.dir === 'asc' ? '▲' : '▼'}` : c;
    th.addEventListener('click', () => {
      if (state.sort === c) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
      else {
        state.sort = c;
        state.dir = 'asc';
      }
      queryRows();
    });
    trh.appendChild(th);
  }
  const thActions = document.createElement('th');
  thActions.textContent = 'Acciones';
  thActions.style.cursor = 'default';
  trh.appendChild(thActions);
  head.appendChild(trh);

  for (const r of state.rows) {
    const tr = document.createElement('tr');
    for (const c of cols) {
      const td = document.createElement('td');
      const v = r[c];
      td.textContent = v === null || v === undefined ? '' : String(v);
      tr.appendChild(td);
    }
    const tdA = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'cell-actions';

    const viewBtn = document.createElement('button');
    viewBtn.className = 'btn btn-secondary btn-sm';
    viewBtn.type = 'button';
    viewBtn.textContent = 'Ver';
    viewBtn.addEventListener('click', () => showJson('Registro', r));
    actions.appendChild(viewBtn);

    if (canEdit && pk) {
      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-secondary btn-sm';
      editBtn.type = 'button';
      editBtn.textContent = 'Editar';
      editBtn.addEventListener('click', () => openRowDialog('edit', r));
      actions.appendChild(editBtn);
    }

    if (canDelete && pk) {
      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-secondary btn-sm';
      delBtn.type = 'button';
      delBtn.textContent = 'Borrar';
      delBtn.addEventListener('click', () => deleteRow(r));
      actions.appendChild(delBtn);
    }

    tdA.appendChild(actions);
    tr.appendChild(tdA);
    body.appendChild(tr);
  }

  setText('tableMeta', `Columnas: ${cols.length} · PK: ${state.schema.pkColumns.join(', ') || '—'}`);
}

function toInputValue(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function validateField(col, value) {
  const type = String(col.type || '').toUpperCase();
  if (col.notnull && (value === null || value === undefined || String(value).trim() === '')) {
    return 'Requerido';
  }
  if (String(value).trim() === '') return null;
  if (state.currentTable === 'users_app' && col.name === 'password_hash') {
    const v = String(value);
    if (/^\$2[aby]\$\d\d\$.{40,}/.test(v)) return null;
    return passwordComplexityError(v);
  }
  if (/INT|REAL|FLOA|DOUB|NUM/.test(type)) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'Número inválido';
  }
  return null;
}

function openRowDialog(mode, row) {
  state.editing = { mode, row: row || null };
  showError('rowError', '');
  const dlg = el('rowDialog');
  const title = mode === 'new' ? 'Nuevo registro' : 'Editar registro';
  setText('rowDialogTitle', title);
  const fields = el('rowFields');
  fields.innerHTML = '';

  const pk = getPkColumn();
  const canEditPk = mode === 'new';

  for (const col of state.schema.columns) {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    const name = document.createElement('span');
    name.textContent = `${col.name}${col.notnull ? ' *' : ''}`;
    const input = document.createElement('input');
    input.name = col.name;
    if (state.currentTable === 'users_app' && col.name === 'password_hash') {
      input.type = 'password';
      input.autocomplete = mode === 'new' ? 'new-password' : 'new-password';
      input.value = '';
      input.placeholder = mode === 'new' ? 'Contraseña (se guardará en hash bcrypt)' : 'Dejar vacío para no cambiar';
    } else {
      input.value = toInputValue(mode === 'new' ? '' : row?.[col.name]);
      input.placeholder = col.type || '';
    }
    input.dataset.type = col.type || '';
    input.dataset.notnull = col.notnull ? '1' : '0';
    input.disabled = !canEditPk && pk === col.name;
    input.addEventListener('input', () => {
      const err = validateField(col, input.value);
      if (err) input.setCustomValidity(err);
      else input.setCustomValidity('');
    });
    wrap.appendChild(name);
    wrap.appendChild(input);
    if (state.currentTable === 'users_app' && col.name === 'password_hash') {
      const note = document.createElement('div');
      note.className = 'inline-note';
      note.textContent = `Requisitos: mínimo ${PASSWORD_POLICY.minLen}, mayúscula, minúscula y número.`;
      wrap.appendChild(note);
    }
    fields.appendChild(wrap);
  }

  dlg.showModal();
}

async function saveRowFromDialog() {
  const mode = state.editing?.mode;
  const pk = getPkColumn();
  const roleRank = getRoleRank(state.user?.role);
  if (roleRank < 2) return;
  const form = el('rowForm');
  const fd = new FormData(form);
  const data = {};

  for (const col of state.schema.columns) {
    const raw = fd.get(col.name);
    const v = raw === null ? '' : String(raw);
    const err = validateField(col, v);
    if (err) {
      showError('rowError', `Campo ${col.name}: ${err}`);
      return;
    }
    if (v.trim() === '') continue;
    const type = String(col.type || '').toUpperCase();
    if (/INT/.test(type)) data[col.name] = Number.parseInt(v, 10);
    else if (/REAL|FLOA|DOUB|NUM/.test(type)) data[col.name] = Number(v);
    else data[col.name] = v;
  }

  try {
    if (state.currentTable === 'users_app' && data.password_hash) {
      const v = String(data.password_hash);
      if (!/^\$2[aby]\$\d\d\$.{40,}/.test(v)) {
        if (!isBcryptAvailable()) throw new Error('No se pudo cargar bcrypt en el navegador.');
        const complexityErr = passwordComplexityError(v);
        if (complexityErr) throw new Error(complexityErr);
        const hash = await bcryptHash(v);
        data.password_hash = hash;
      }
    }

    if (mode === 'new') {
      await apiFetch(`/admin/api/tables/${encodeURIComponent(state.currentTable)}/rows`, {
        method: 'POST',
        body: JSON.stringify({ data })
      });
    } else {
      const id = String(state.editing?.row?.[pk] ?? '');
      if (!id) throw new Error('No se pudo determinar la PK del registro');
      await apiFetch(`/admin/api/tables/${encodeURIComponent(state.currentTable)}/rows/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ data })
      });
    }
    el('rowDialog').close();
    await queryRows();
  } catch (err) {
    showError('rowError', err?.message || 'Error de conexión');
  }
}

async function deleteRow(row) {
  const pk = getPkColumn();
  if (!pk) return;
  const id = String(row?.[pk] ?? '');
  if (!id) return;
  if (!confirm(`Eliminar ${state.currentTable}.${pk}=${id}?`)) return;
  try {
    await apiFetch(`/admin/api/tables/${encodeURIComponent(state.currentTable)}/rows/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'X-Confirm-Delete': 'yes' }
    });
    await queryRows();
  } catch (err) {
    alert(err.message);
  }
}

function buildExportUrl(format) {
  const base = `/admin/api/tables/${encodeURIComponent(state.currentTable)}/export`;
  const params = new URLSearchParams();
  params.set('format', format);
  params.set('limit', String(Math.min(5000, state.pageSize * 10)));
  if (state.q) params.set('q', state.q);
  if (state.sort) {
    params.set('sort', state.sort);
    params.set('dir', state.dir);
  }
  if (state.filters.length) params.set('filters', JSON.stringify(state.filters));
  return `${base}?${params.toString()}`;
}

function download(format) {
  if (!state.currentTable) return;
  const url = buildExportUrl(format);
  window.open(url, '_blank', 'noopener,noreferrer');
}

function showJson(title, obj) {
  setText('genericTitle', title);
  el('genericContent').textContent = JSON.stringify(obj, null, 2);
  el('genericDialog').showModal();
}

async function openAudit() {
  const out = await apiFetch(`/admin/api/audit?page=1&pageSize=100`);
  const body = el('auditBody');
  body.innerHTML = '';
  for (const r of out.rows || []) {
    const tr = document.createElement('tr');
    const tdDate = document.createElement('td');
    tdDate.textContent = r.created_at || '';
    const tdAction = document.createElement('td');
    tdAction.textContent = r.action || '';
    const tdActor = document.createElement('td');
    tdActor.textContent = r.actor_username ? `${r.actor_username} (${r.actor_role || ''})` : '';
    const tdTable = document.createElement('td');
    tdTable.textContent = r.table_name || '';
    const tdPk = document.createElement('td');
    tdPk.textContent = r.record_pk || '';
    const tdDet = document.createElement('td');
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary btn-sm';
    btn.type = 'button';
    btn.textContent = 'Ver';
    btn.addEventListener('click', () => showJson('Evento de auditoría', r));
    tdDet.appendChild(btn);
    tr.appendChild(tdDate);
    tr.appendChild(tdAction);
    tr.appendChild(tdActor);
    tr.appendChild(tdTable);
    tr.appendChild(tdPk);
    tr.appendChild(tdDet);
    body.appendChild(tr);
  }
  el('auditDialog').showModal();
}

async function openBackups() {
  const out = await apiFetch(`/admin/api/backups?page=1&pageSize=100`);
  const body = el('backupsBody');
  body.innerHTML = '';
  for (const r of out.rows || []) {
    const tr = document.createElement('tr');
    const tdDate = document.createElement('td');
    tdDate.textContent = r.created_at || '';
    const tdReason = document.createElement('td');
    tdReason.textContent = r.reason || '';
    const tdActor = document.createElement('td');
    tdActor.textContent = r.actor_user_id ? String(r.actor_user_id) : '';
    const tdPath = document.createElement('td');
    tdPath.textContent = r.backup_path || '';
    tr.appendChild(tdDate);
    tr.appendChild(tdReason);
    tr.appendChild(tdActor);
    tr.appendChild(tdPath);
    body.appendChild(tr);
  }
  el('backupsDialog').showModal();
}

async function openUsers() {
  showError('usersError', '');
  const out = await apiFetch(`/admin/api/users`);
  const body = el('usersBody');
  body.innerHTML = '';
  for (const u of out.users || []) {
    const tr = document.createElement('tr');
    const tdId = document.createElement('td');
    tdId.textContent = u.id;
    const tdUser = document.createElement('td');
    tdUser.textContent = u.username;
    const tdRole = document.createElement('td');
    const sel = document.createElement('select');
    sel.className = 'select-sm';
    for (const r of ['viewer', 'editor', 'admin']) {
      const opt = document.createElement('option');
      opt.value = r;
      opt.textContent = r;
      if (u.role === r) opt.selected = true;
      sel.appendChild(opt);
    }
    tdRole.appendChild(sel);
    const tdActive = document.createElement('td');
    const selA = document.createElement('select');
    selA.className = 'select-sm';
    const optY = document.createElement('option');
    optY.value = '1';
    optY.textContent = 'sí';
    const optN = document.createElement('option');
    optN.value = '0';
    optN.textContent = 'no';
    selA.appendChild(optY);
    selA.appendChild(optN);
    selA.value = u.is_active ? '1' : '0';
    tdActive.appendChild(selA);

    const tdPass = document.createElement('td');
    const passWrap = document.createElement('div');
    passWrap.style.display = 'grid';
    passWrap.style.gap = '6px';
    const passInput = document.createElement('input');
    passInput.className = 'input-sm';
    passInput.type = 'password';
    passInput.autocomplete = 'new-password';
    passInput.placeholder = 'Nueva contraseña…';
    const passNote = document.createElement('div');
    passNote.className = 'inline-note';
    passNote.textContent = '';
    const dirtyKey = String(u.id);
    state.usersPasswordDirty.set(dirtyKey, false);
    passInput.addEventListener('input', () => {
      const v = passInput.value || '';
      if (!v) {
        state.usersPasswordDirty.set(dirtyKey, false);
        passNote.textContent = '';
        passNote.classList.remove('warn', 'ok');
        return;
      }
      state.usersPasswordDirty.set(dirtyKey, true);
      const err = passwordComplexityError(v);
      if (err) {
        passNote.textContent = err;
        passNote.classList.add('warn');
        passNote.classList.remove('ok');
      } else {
        passNote.textContent = 'Lista para guardar (se enviará solo el hash)';
        passNote.classList.add('ok');
        passNote.classList.remove('warn');
      }
    });
    passWrap.appendChild(passInput);
    passWrap.appendChild(passNote);
    tdPass.appendChild(passWrap);

    const tdLock = document.createElement('td');
    tdLock.textContent = u.locked_until_ms ? `hasta ${new Date(Number(u.locked_until_ms)).toISOString()}` : '';
    const tdAct = document.createElement('td');
    const btnSave = document.createElement('button');
    btnSave.className = 'btn btn-secondary btn-sm';
    btnSave.type = 'button';
    btnSave.textContent = 'Guardar';
    btnSave.addEventListener('click', async () => {
      try {
        btnSave.disabled = true;
        const payload = { role: sel.value, is_active: selA.value === '1' };
        const plain = passInput.value || '';
        if (plain) {
          const err = passwordComplexityError(plain);
          if (err) throw Object.assign(new Error(err), { status: 400 });
          const hash = await bcryptHash(plain);
          payload.password_hash_bcrypt = hash;
        }
        await apiFetch(`/admin/api/users/${encodeURIComponent(u.id)}`, {
          method: 'PATCH',
          body: JSON.stringify(payload)
        });
        passInput.value = '';
        passInput.dispatchEvent(new Event('input'));
        await openUsers();
      } catch (err) {
        showError('usersError', formatUsersError(err));
      } finally {
        btnSave.disabled = false;
      }
    });
    tdAct.appendChild(btnSave);
    tr.appendChild(tdId);
    tr.appendChild(tdUser);
    tr.appendChild(tdRole);
    tr.appendChild(tdActive);
    tr.appendChild(tdPass);
    tr.appendChild(tdLock);
    tr.appendChild(tdAct);
    body.appendChild(tr);
  }
  el('usersDialog').showModal();
}

function bindUi() {
  el('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('loginError', '');
    const username = el('username').value.trim();
    const password = el('password').value;
    try {
      await login(username, password);
      setHidden('loginView', true);
      setHidden('adminView', false);
      await loadTables();
    } catch (err) {
      showError('loginError', err.message);
    }
  });

  el('logoutBtn').addEventListener('click', () => {
    state.user = null;
    saveToken(null);
    state.currentTable = null;
    setHidden('loginView', false);
    setHidden('adminView', true);
    updateSessionUi();
  });

  el('refreshTablesBtn').addEventListener('click', () => loadTables());

  el('searchBtn').addEventListener('click', () => {
    state.q = el('searchInput').value.trim();
    state.page = 1;
    queryRows();
  });

  el('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      el('searchBtn').click();
    }
  });

  el('addFilterBtn').addEventListener('click', () => {
    const column = el('filterColumn').value;
    const op = el('filterOp').value;
    const value = el('filterValue').value;
    if (!column) return;
    const f = { column, op };
    if (op !== 'isNull' && op !== 'isNotNull') f.value = value;
    state.filters.push(f);
    el('filterValue').value = '';
    renderFilters();
    state.page = 1;
    queryRows();
  });

  el('clearFiltersBtn').addEventListener('click', () => {
    state.filters = [];
    renderFilters();
    state.page = 1;
    queryRows();
  });

  el('prevPageBtn').addEventListener('click', () => {
    state.page = Math.max(1, state.page - 1);
    queryRows();
  });
  el('nextPageBtn').addEventListener('click', () => {
    state.page = state.page + 1;
    queryRows();
  });

  el('pageSizeSelect').addEventListener('change', () => {
    state.pageSize = Number(el('pageSizeSelect').value) || 25;
    state.page = 1;
    queryRows();
  });

  el('addRowBtn').addEventListener('click', () => openRowDialog('new'));
  el('exportCsvBtn').addEventListener('click', () => download('csv'));
  el('exportXlsxBtn').addEventListener('click', () => download('xlsx'));
  el('exportPdfBtn').addEventListener('click', () => download('pdf'));

  el('rowForm').addEventListener('submit', (e) => {
    e.preventDefault();
    saveRowFromDialog();
  });

  el('openAuditBtn').addEventListener('click', () => openAudit());
  el('openBackupsBtn').addEventListener('click', () => openBackups());
  el('openUsersBtn').addEventListener('click', () => openUsers());

  el('createUserBtn').addEventListener('click', async () => {
    showError('usersError', '');
    const username = el('newUserUsername').value.trim();
    const password = el('newUserPassword').value;
    const role = el('newUserRole').value;
    const isActive = el('newUserActive').value === '1';
    if (!username || !password) {
      showError('usersError', 'Usuario y contraseña son requeridos');
      return;
    }
    try {
      const err = passwordComplexityError(password);
      if (err) {
        showError('usersError', err);
        return;
      }
      if (!isBcryptAvailable()) {
        showError('usersError', 'No se pudo cargar bcrypt en el navegador.');
        return;
      }
      const hash = await bcryptHash(password);
      await apiFetch(`/admin/api/users`, {
        method: 'POST',
        body: JSON.stringify({ username, password_hash_bcrypt: hash, role, is_active: isActive })
      });
      el('newUserUsername').value = '';
      el('newUserPassword').value = '';
      await openUsers();
    } catch (err) {
      showError('usersError', formatUsersError(err));
    }
  });
}

async function boot() {
  bindUi();
  const token = localStorage.getItem('adminToken');
  if (token) saveToken(token);
  if (!state.token) return;
  try {
    await loadMe();
    setHidden('loginView', true);
    setHidden('adminView', false);
    await loadTables();
  } catch {
    saveToken(null);
  }
}

boot();
