# Documentación técnica — Admin BD

## Resumen
Este proyecto incluye un panel web para administración total de la base de datos SQLite (CRUD, búsqueda/filtrado, ordenamiento, paginación, exportaciones, respaldos automáticos, control de acceso por roles y auditoría).

- Backend: Express + sqlite3
- UI: HTML/CSS/JS (sin frameworks), servido en `/admin`
- API de admin: prefijo `/admin/api`

## Componentes
- Backend principal: [server.js](file:///Volumes/Minim4/externo/Documents/Reac-native-2025/proyecto/BackendLavanderia%20App/server.js)
- Conexión/creación de esquema SQLite: [database.js](file:///Volumes/Minim4/externo/Documents/Reac-native-2025/proyecto/BackendLavanderia%20App/database.js)
- Módulo Admin (auth/CRUD/export/backup/audit): [admin.js](file:///Volumes/Minim4/externo/Documents/Reac-native-2025/proyecto/BackendLavanderia%20App/admin.js)
- UI Admin: [admin/index.html](file:///Volumes/Minim4/externo/Documents/Reac-native-2025/proyecto/BackendLavanderia%20App/admin/index.html), [admin/app.js](file:///Volumes/Minim4/externo/Documents/Reac-native-2025/proyecto/BackendLavanderia%20App/admin/app.js), [admin/styles.css](file:///Volumes/Minim4/externo/Documents/Reac-native-2025/proyecto/BackendLavanderia%20App/admin/styles.css)

## Tablas nuevas (admin)
Se crean automáticamente al iniciar:
- `admin_users`: usuarios del panel (hash/role/bloqueos)
- `admin_audit_log`: bitácora de auditoría para operaciones del panel
- `admin_backups`: historial de respaldos previos a cambios críticos

## Autenticación y roles
### Autenticación
- Login: `POST /admin/api/auth/login`
- Token: JWT HS256 firmado (Bearer), con expiración.
- Hash de password: PBKDF2 (sha256, 150000 iteraciones, salt aleatorio).

### Roles
- `viewer`: lectura (tablas, esquema, listar, exportar)
- `editor`: `viewer` + crear/editar
- `admin`: `editor` + eliminar + gestión de usuarios + auditoría + respaldos

### Bloqueo por intentos
En `admin_users` se registran:
- `failed_attempts`
- `locked_until_ms`

## Prevención de SQL injection
- Identificadores (tabla/columna) se validan con regex y contra el esquema (`sqlite_master` + `PRAGMA table_info`).
- Valores siempre se envían como parámetros (`?`) a sqlite3.

## Auditoría
Se inserta un registro en `admin_audit_log` en:
- Login OK/FAIL/LOCKED
- Listado de tablas (`LIST_TABLES`)
- Lectura de esquema (`GET_SCHEMA`)
- Listado de registros (`LIST_ROWS`)
- CRUD (`CREATE_ROW`, `UPDATE_ROW`, `DELETE_ROW`)
- Exportaciones (`EXPORT`)

Para `UPDATE_ROW` y `DELETE_ROW`, se persiste `before_json`/`after_json`.

## Respaldos automáticos
Antes de `CREATE/UPDATE/DELETE` se genera un respaldo:
- Directorio: `<SQLITE_DATA_DIR>/.data/backups` (por defecto: `./.data/backups`)
- Método: `VACUUM INTO` (y fallback a copia del archivo si falla)
- Registro: tabla `admin_backups`

## Exportación de datos
Endpoint:
- `GET /admin/api/tables/:table/export?format=csv|xlsx|pdf`

Notas:
- CSV: se genera manualmente con escapado correcto.
- Excel: `exceljs` genera `.xlsx`.
- PDF: `pdfkit` genera un reporte simple (texto por fila).

## Cifrado de datos sensibles (opcional)
Se soporta cifrado a nivel de columna para campos configurados por ambiente:
- `ADMIN_DATA_KEY`: clave AES-256-GCM en base64 (32 bytes).
- `ADMIN_ENCRYPT_COLUMNS`: lista separada por comas con `tabla.columna` (ej: `orders.telefono,orders.cliente`).

Si no se define `ADMIN_DATA_KEY`, no se cifra (se almacena plano).

## Variables de entorno
- `PORT`: puerto del servidor (default 3001)
- `SQLITE_DATA_DIR`: carpeta para `.data` (default `./.data`)
- `SQLITE_DB_PATH`: ruta del `.db` (default `./.data/lavanderia.db`)
- `ADMIN_JWT_SECRET`: secreto HS256 (recomendado >= 32 caracteres)
- `ADMIN_INITIAL_USER`: usuario inicial (default `admin`)
- `ADMIN_INITIAL_PASSWORD`: password inicial (si no existe, se genera y se imprime en consola)
- `ADMIN_MAX_LOGIN_ATTEMPTS`: intentos antes de bloquear (default 5)
- `ADMIN_LOCK_MINUTES`: minutos de bloqueo (default 15)
- `ADMIN_TOKEN_TTL_SECONDS`: TTL del token (default 28800 = 8 horas)
- `ADMIN_DATA_KEY`: clave base64 de 32 bytes para cifrado (opcional)
- `ADMIN_ENCRYPT_COLUMNS`: columnas a cifrar (opcional)

## Seguridad web (UI)
Al servir `/admin` se agregan headers:
- CSP restrictivo (`default-src 'self'`, sin scripts inline)
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, etc.

## Ejecución
```bash
npm install
npm start
```
- Panel: `http://localhost:3001/admin`
- Health: `http://localhost:3001/health`

## Observación sobre dependencias
`npm audit --omit=dev` reporta 2 vulnerabilidades moderadas asociadas a `uuid` transitivo de `exceljs`. No hay fix directo sin un cambio mayor de dependencias; si se requiere eliminar completamente este riesgo, se debe reemplazar la exportación Excel por otra implementación sin esa dependencia.

