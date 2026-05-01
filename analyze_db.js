const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./lavanderia.db');

const queries = {
  // 1. Orphaned order_items (order doesn't exist)
  orphanedOrderItems: `
    SELECT id, order_id, service_id 
    FROM order_items 
    WHERE order_id NOT IN (SELECT id FROM orders)
  `,
  // 2. Orphaned order_items (service doesn't exist)
  orphanedOrderItemsServices: `
    SELECT id, order_id, service_id 
    FROM order_items 
    WHERE service_id NOT IN (SELECT id FROM services)
  `,
  // 3. Orphaned ironing jobs (personnel doesn't exist but has assigned_id)
  orphanedIroningJobsPersonnel: `
    SELECT id, nombre_cliente, asignado_id 
    FROM ironing_jobs 
    WHERE asignado_id IS NOT NULL 
    AND asignado_id NOT IN (SELECT id FROM ironing_personnel)
  `,
  // 4. Invalid status in orders
  invalidOrderStates: `
    SELECT id, estado 
    FROM orders 
    WHERE estado NOT IN ('Enproceso', 'Terminado', 'Entregado', 'Cancelado', 'Pendiente', 'Completado') -- Adjust based on actual valid states
  `,
  // 5. Invalid status in ironing jobs
  invalidIroningJobStates: `
    SELECT id, status 
    FROM ironing_jobs 
    WHERE status NOT IN ('En Espera', 'En Proceso', 'Terminado') -- Adjust based on actual valid states
  `
};

db.serialize(() => {
  console.log("=== INICIO DE ANÁLISIS DE INTEGRIDAD ===\n");
  
  Object.keys(queries).forEach(key => {
    db.all(queries[key], (err, rows) => {
      if (err) {
        console.error(`Error executing ${key}:`, err.message);
        return;
      }
      console.log(`--- Análisis: ${key} ---`);
      if (rows.length === 0) {
        console.log("OK: 0 registros inconsistentes encontrados.");
      } else {
        console.log(`ALERTA: Se encontraron ${rows.length} registros inconsistentes.`);
        console.table(rows);
      }
      console.log("");
    });
  });
});

db.close();
