# Manual de usuario — Admin BD

## Acceso al panel
1. Inicia el servidor (`npm start`).
2. Abre: `http://localhost:3001/admin`
3. Ingresa usuario y contraseña.

Si es la primera vez que se inicia el sistema y no hay usuarios, se crea un usuario inicial:
- Usuario: `admin` (o `ADMIN_INITIAL_USER`)
- Password: `ADMIN_INITIAL_PASSWORD` o una generada automáticamente que se muestra en consola.
Usuario: admin
 Contraseña (reseteada ahora mismo): 5kysZNlUOXcX-rPY

## Navegación general
- En la barra lateral izquierda aparece la lista de tablas.
- Al seleccionar una tabla se muestra:
  - Buscador por texto (busca en columnas tipo texto).
  - Filtros por columna (operadores como `=`, `contiene`, `>`, `is NULL`, etc.).
  - Tabla con resultados (ordenable al hacer clic en encabezados).
  - Paginación y tamaño de página.

## Búsqueda y filtrado
### Búsqueda rápida
- Escribe en “Buscar (texto)” y presiona “Buscar”.
- Aplica sobre columnas tipo texto.

### Filtros
1. Selecciona columna.
2. Selecciona operador.
3. Escribe valor si aplica.
4. Presiona “Agregar filtro”.

Acciones:
- Cada filtro queda como una “etiqueta” (chip) y se puede eliminar con “×”.
- “Limpiar” elimina todos los filtros.

## Ordenamiento y paginación
- Haz clic en el encabezado de una columna para ordenar ascendente/descendente.
- Usa “Anterior / Siguiente” para navegar páginas.
- Cambia el tamaño de página con el selector (10/25/50/100).

## CRUD (crear/editar/eliminar)
### Crear
- Presiona “Nuevo”.
- Completa campos requeridos (marcados con `*`).
- Presiona “Guardar”.

### Editar
- En la fila, presiona “Editar”.
- Modifica los campos (la PK no se edita).
- Presiona “Guardar”.

### Eliminar
- En la fila, presiona “Borrar”.
- Confirma en el diálogo de confirmación del navegador.

Notas:
- Antes de cambios críticos (crear/editar/eliminar) el sistema genera un respaldo automático.
- Todas las operaciones quedan registradas en la auditoría.

## Exportación (CSV / Excel / PDF)
Con una tabla seleccionada:
- CSV: botón “CSV”
- Excel: botón “Excel”
- PDF: botón “PDF”

La exportación respeta:
- búsqueda (texto),
- filtros,
- ordenamiento actual.

## Auditoría (solo rol admin)
En “Herramientas”:
- “Auditoría” muestra los últimos eventos registrados (login, CRUD, exportaciones, etc.).
- Puedes abrir el detalle completo de un evento con “Ver”.

## Respaldos (solo rol admin)
En “Herramientas”:
- “Respaldos” lista respaldos generados automáticamente antes de cambios.
- Se muestra fecha, motivo y ruta del archivo.

## Usuarios y permisos (solo rol admin)
En “Herramientas”:
- “Usuarios” permite:
  - Crear usuarios con rol `viewer`, `editor` o `admin`.
  - Activar/desactivar usuarios.
  - Cambiar rol.
  - Resetear contraseña (“Reset pass”).

## Recomendaciones operativas
- Cambiar inmediatamente la contraseña inicial.
- Configurar `ADMIN_JWT_SECRET` (mínimo 32 caracteres).
- Restringir acceso al panel en producción (VPN o IP allowlist) y servir por HTTPS.
- Respaldar la carpeta `.data/backups` según política de retención.

