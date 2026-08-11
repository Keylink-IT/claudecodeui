// One-time migration of 1.28 custom renames into the 1.33 DB.
// Non-destructive: only SETS custom_project_name / custom_name. Re-runnable.
// Persists across reboots (createProjectPath's ON CONFLICT does not touch custom_project_name).
const D = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const { randomUUID } = require('node:crypto');

const dbPath = process.env.DATABASE_PATH || os.homedir() + '/.cloudcli/auth.db';
const db = new D(dbPath);
const normalize = (p) => {
  let s = String(p).trim().replace(/[\\/]+$/, '');
  return s || String(p);
};

// ---- project renames: ~/.claude/project-config.json (key=encoded dir, val.originalPath + val.displayName)
const cfg = JSON.parse(fs.readFileSync(os.homedir() + '/.claude/project-config.json', 'utf8'));
const upProj = db.prepare('UPDATE projects SET custom_project_name = ? WHERE project_path = ?');
const insProj = db.prepare('INSERT OR IGNORE INTO projects (project_id, project_path, custom_project_name, isArchived) VALUES (?, ?, ?, 0)');
let pOk = 0, pIns = 0;
const misses = [];
for (const [, v] of Object.entries(cfg)) {
  if (!v || !v.displayName || !v.originalPath) continue;
  const target = normalize(v.originalPath);
  let r = upProj.run(v.displayName, target);
  if (r.changes === 0) {
    // sessionless manually-added project — 1.33 never created the row. Insert it.
    insProj.run(randomUUID(), target, v.displayName);
    r = upProj.run(v.displayName, target);
    if (r.changes > 0) { pIns++; continue; }
  }
  if (r.changes > 0) pOk++;
  else misses.push(v.displayName + '  ->  ' + target);
}
console.log('PROJECT renames applied:', pOk, '  inserted (sessionless):', pIns, '  missed:', misses.length);
misses.forEach((m) => console.log('  MISS:', m));

// ---- session renames: captured session-names.json (session_id -> custom_name)
let sOk = 0;
try {
  const sn = JSON.parse(fs.readFileSync('/app/session-names.json', 'utf8'));
  const upSess = db.prepare('UPDATE sessions SET custom_name = ? WHERE session_id = ?');
  for (const s of sn) {
    if (!s.custom_name || !s.session_id) continue;
    if (upSess.run(s.custom_name, s.session_id).changes > 0) sOk++;
  }
  console.log('SESSION renames applied:', sOk, '/', sn.length);
} catch (e) {
  console.log('session renames skipped:', e.message);
}
