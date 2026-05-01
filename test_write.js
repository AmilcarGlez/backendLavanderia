const sqlite3 = require('sqlite3').verbose();
const dbPath = '/Volumes/Minim4/externo/Documents/Reac-native-2025/proyecto/BackendLavanderia App/.data/lavanderia.db';
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Connection error:', err.message);
    return;
  }
  console.log('Connected.');
  db.run("UPDATE app_settings SET value = '50' WHERE key = 'ironing_daily_limit'", function(err) {
    if (err) {
      console.error('Update error:', err.message);
    } else {
      console.log('Update success, changes:', this.changes);
    }
    db.close();
  });
});
