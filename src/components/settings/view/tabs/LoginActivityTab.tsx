import { useEffect, useState } from 'react';
import { Activity, Radio, RefreshCw } from 'lucide-react';
import { api } from '../../../../utils/api';
import { Button } from '../../../../shared/view/ui';

type LoginEvent = {
  id: number;
  event_type: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  username: string | null;
};

type ActiveSession = {
  ip: string | null;
  userAgent: string | null;
  connectedAt: string;
  activity: {
    provider: string;
    sessionId: string | null;
    projectPath: string | null;
    isResume: boolean;
    commandPreview: string | null;
    lastActivityAt: string;
  } | null;
};

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (isNaN(then)) return iso;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

function shortPath(p: string | null): string {
  if (!p) return '—';
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts.length <= 2 ? p : '…/' + parts.slice(-2).join('/');
}

// Compress a UA string into something readable in a table cell. We don't need
// fingerprint-grade detail here — "Chrome on macOS" is enough to tell two
// team members apart at a glance.
function summarizeUserAgent(ua: string | null): string {
  if (!ua) return '—';
  const browser =
    /Edg\//.test(ua) ? 'Edge' :
    /Chrome\//.test(ua) ? 'Chrome' :
    /Firefox\//.test(ua) ? 'Firefox' :
    /Safari\//.test(ua) ? 'Safari' :
    'Browser';
  const os =
    /Windows/.test(ua) ? 'Windows' :
    /Mac OS X|Macintosh/.test(ua) ? 'macOS' :
    /Android/.test(ua) ? 'Android' :
    /iPhone|iPad|iOS/.test(ua) ? 'iOS' :
    /Linux/.test(ua) ? 'Linux' :
    'Unknown';
  return `${browser} on ${os}`;
}

function formatTimestamp(iso: string): string {
  // Stored as UTC SQLite CURRENT_TIMESTAMP — append Z so JS parses correctly.
  const d = new Date(iso.endsWith('Z') ? iso : iso.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export default function LoginActivityTab() {
  const [events, setEvents] = useState<LoginEvent[]>([]);
  const [active, setActive] = useState<ActiveSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0); // forces relative-time labels to refresh

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [eventsRes, activeRes] = await Promise.all([
        api.auth.loginEvents(50),
        api.auth.activeSessions(),
      ]);
      if (!eventsRes.ok) throw new Error(`login-events HTTP ${eventsRes.status}`);
      if (!activeRes.ok) throw new Error(`active-sessions HTTP ${activeRes.status}`);
      const eventsData = await eventsRes.json();
      const activeData = await activeRes.json();
      setEvents(eventsData.events || []);
      setActive(activeData.sessions || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load activity');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // Refresh active sessions every 10s; relative-time labels every 1s.
    const dataInterval = setInterval(load, 10000);
    const tickInterval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      clearInterval(dataInterval);
      clearInterval(tickInterval);
    };
  }, []);
  void tick; // referenced so the interval-driven re-render isn't elided

  return (
    <section className="space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
            <Activity className="h-5 w-5" />
            Team activity
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Recent logins to this lab instance. The lab is a single shared account, so the IP and browser are
            what differentiate team members.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`mr-2 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </header>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Now panel — what's currently being worked on */}
      <div className="space-y-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Radio className="h-4 w-4 text-emerald-500" />
          Now ({active.length} {active.length === 1 ? 'session' : 'sessions'} connected)
        </h3>
        {active.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
            No one is currently connected.
          </p>
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">IP</th>
                  <th className="px-3 py-2 text-left font-medium">Browser</th>
                  <th className="px-3 py-2 text-left font-medium">Provider</th>
                  <th className="px-3 py-2 text-left font-medium">Project</th>
                  <th className="px-3 py-2 text-left font-medium">Last action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {active.map((s, i) => (
                  <tr key={`${s.ip}-${s.connectedAt}-${i}`} className="hover:bg-accent/30">
                    <td className="px-3 py-2 font-mono text-xs text-foreground">{s.ip || '—'}</td>
                    <td className="px-3 py-2 text-muted-foreground">{summarizeUserAgent(s.userAgent)}</td>
                    <td className="px-3 py-2 capitalize text-foreground">
                      {s.activity?.provider || <span className="text-muted-foreground">idle</span>}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground" title={s.activity?.projectPath || ''}>
                      {shortPath(s.activity?.projectPath || null)}
                      {s.activity?.commandPreview && (
                        <div className="mt-0.5 truncate text-xs italic text-muted-foreground/80" title={s.activity.commandPreview}>
                          “{s.activity.commandPreview}”
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {s.activity ? formatRelative(s.activity.lastActivityAt) : `connected ${formatRelative(s.connectedAt)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Recent logins */}
      <h3 className="text-sm font-semibold text-foreground">Recent logins</h3>
      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">When</th>
              <th className="px-3 py-2 text-left font-medium">Event</th>
              <th className="px-3 py-2 text-left font-medium">IP</th>
              <th className="px-3 py-2 text-left font-medium">Browser</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading && events.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {!loading && events.length === 0 && !error && (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">No login events yet.</td></tr>
            )}
            {events.map((ev) => (
              <tr key={ev.id} className="hover:bg-accent/30">
                <td className="px-3 py-2 whitespace-nowrap text-foreground">{formatTimestamp(ev.created_at)}</td>
                <td className="px-3 py-2 capitalize text-muted-foreground">{ev.event_type}</td>
                <td className="px-3 py-2 font-mono text-xs text-foreground">{ev.ip_address || '—'}</td>
                <td className="px-3 py-2 text-muted-foreground">{summarizeUserAgent(ev.user_agent)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
