// Persisted login / registration history for the Team activity Settings tab.
//
// In 1.28 this lived in server/database/db.js; 1.33 moved the DB into
// modules/database, so this self-contained helper borrows the shared
// better-sqlite3 connection (getConnection) and lazily ensures its own table
// the first time it's used -- the core schema/migrations stay untouched.
// Recording is best-effort and must never throw into the auth hot path.
import { getConnection } from './modules/database/index.js';

let ensured = false;
function table() {
  const db = getConnection();
  if (!ensured) {
    db.exec(`CREATE TABLE IF NOT EXISTS login_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      event_type TEXT NOT NULL DEFAULT 'login',
      ip_address TEXT,
      user_agent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_login_events_user_id ON login_events(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_login_events_created_at ON login_events(created_at DESC)');
    ensured = true;
  }
  return db;
}

export const loginEventsDb = {
  /**
   * @param {number|bigint} userId
   * @param {{ eventType?: string, ipAddress?: string|null, userAgent?: string|null }} [opts]
   */
  recordEvent: (userId, { eventType = 'login', ipAddress = null, userAgent = null } = {}) => {
    try {
      table()
        .prepare('INSERT INTO login_events (user_id, event_type, ip_address, user_agent) VALUES (?, ?, ?, ?)')
        .run(userId, eventType, ipAddress, userAgent);
    } catch (err) {
      // Non-fatal — auth must never fail because logging failed.
      console.warn('Failed to record login event:', err.message);
    }
  },

  getRecentEvents: (limit = 50) => {
    try {
      return table()
        .prepare(`
        SELECT le.id, le.event_type, le.ip_address, le.user_agent, le.created_at, u.username
        FROM login_events le
        LEFT JOIN users u ON le.user_id = u.id
        ORDER BY le.created_at DESC
        LIMIT ?
      `)
        .all(limit);
    } catch (err) {
      console.warn('Failed to fetch login events:', err.message);
      return [];
    }
  },
};
