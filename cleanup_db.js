const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./lavanderia.db');

db.serialize(() => {
  console.log("=== INICIANDO DEPURACIÓN DE BASE DE DATOS ===\n");
  
  // Iniciamos una transacción para asegurar atomicidad
  db.run("BEGIN TRANSACTION", (err) => {
    if (err) {
      console.error("Error al iniciar transacción:", err);
      return;
    }
    console.log("Transacción iniciada correctamente.");

    // Corrección: Actualizar estados de 'Completado' a 'Terminado' en ironing_jobs
    const sqlUpdateIroningJobs = "UPDATE ironing_jobs SET status = 'Terminado' WHERE status = 'Completado'";
    db.run(sqlUpdateIroningJobs, function(err) {
      if (err) {
        console.error("Error actualizando ironing_jobs:", err);
        db.run("ROLLBACK");
        return;
      }
      console.log(`Corregidos ${this.changes} registros en ironing_jobs (estado normalizado a 'Terminado').`);
      
      const sqlDeleteOrphanedOrderItems = "DELETE FROM order_items WHERE order_id NOT IN (SELECT id FROM orders)";
      db.run(sqlDeleteOrphanedOrderItems, function(err) {
        if (err) {
          console.error("Error eliminando order_items huérfanos:", err);
          db.run("ROLLBACK");
          return;
        }
        console.log(`Depurados ${this.changes} order_items huérfanos.`);
        
        db.run("COMMIT", (err) => {
          if (err) {
            console.error("Error al hacer COMMIT:", err);
            db.run("ROLLBACK");
          } else {
            console.log("\n=== DEPURACIÓN FINALIZADA Y CAMBIOS APLICADOS CON ÉXITO ===");
          }
          db.close(); // Mover db.close() aquí dentro del callback final de la transacción
        });
      });
    });
  });
});
