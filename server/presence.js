// In-memory presence tracking — ephemeral, not persisted. Powers the "Now"
// section of the Team activity Settings tab: which WebSockets are currently
// connected, what they're working on, and from where.
//
// Why ephemeral and not in auth.db: this is "right now" data, not history.
// On server restart the truth is whatever's currently connected, and the
// active connections will re-register on reconnect. No DB write fan-out
// per chat message either, which would otherwise be a noisy hotpath.

const connections = new Map(); // ws -> { ip, userAgent, connectedAt, currentActivity }

function getClientIpFromRequest(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    null
  );
}

export function register(ws, request) {
  connections.set(ws, {
    ip: getClientIpFromRequest(request),
    userAgent: request.headers['user-agent'] || null,
    connectedAt: new Date().toISOString(),
    currentActivity: null,
  });
  ws.on('close', () => connections.delete(ws));
}

// Called when a chat WebSocket sends a provider command (claude/cursor/codex/gemini).
// Records the most recent activity for that connection so the Now panel can show
// "Project X via Claude, last action 30s ago."
export function noteActivity(ws, { provider, sessionId, projectPath, command, isResume }) {
  const entry = connections.get(ws);
  if (!entry) return;
  entry.currentActivity = {
    provider,
    sessionId: sessionId || null,
    projectPath: projectPath || null,
    isResume: Boolean(isResume),
    // Brief preview only — first 80 chars, never a full prompt. The team can
    // see *what topic* is being worked on without us storing full prompts.
    commandPreview: typeof command === 'string' && command
      ? command.slice(0, 80) + (command.length > 80 ? '…' : '')
      : null,
    lastActivityAt: new Date().toISOString(),
  };
}

export function list() {
  return Array.from(connections.values()).map((entry) => ({
    ip: entry.ip,
    userAgent: entry.userAgent,
    connectedAt: entry.connectedAt,
    activity: entry.currentActivity,
  }));
}
