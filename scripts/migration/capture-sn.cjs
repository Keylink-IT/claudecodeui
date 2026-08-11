// Capture 1.28 session_names (1.33 drops the table on boot) -> JSON for the migration.
const D = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const db = new D(os.homedir() + '/.cloudcli/auth.db', { readonly: true });
const rows = db.prepare('SELECT session_id, custom_name FROM session_names').all();
fs.writeFileSync('/tmp/session-names.json', JSON.stringify(rows, null, 2));
console.log('captured', rows.length, 'session renames -> /tmp/session-names.json');
