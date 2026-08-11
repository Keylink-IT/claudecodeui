import express from 'express';
import type { RequestHandler } from 'express';

import type { createAuthService } from './auth.service.js';
// Fork (lab.keylinkit): presence "Now" panel + login-activity recorder.
import * as presence from '@/presence.js';
import { loginEventsDb } from '@/login-events.js';

type AuthenticatedRequest = express.Request & { user?: unknown };

// Resolve the real client IP behind the Cloudflare Tunnel: CF-Connecting-IP is
// the browser's address; X-Forwarded-For is the fallback; req.ip is last.
function getClientIp(req: express.Request): string | null {
  const cf = req.headers['cf-connecting-ip'];
  const xff = req.headers['x-forwarded-for'];
  return (
    (Array.isArray(cf) ? cf[0] : cf) ||
    (typeof xff === 'string' ? xff.split(',')[0].trim() : undefined) ||
    req.ip ||
    null
  );
}

/**
 * Creates the Auth transport adapter. Handlers only parse request data and
 * delegate authentication behavior to the injected application service.
 */
export function createAuthRouter(
  service: ReturnType<typeof createAuthService>,
  authenticateToken: RequestHandler,
): express.Router {
  const router = express.Router();

  router.get('/status', (_req, res, next) => {
    try {
      res.json(service.getStatus());
    } catch (error) {
      next(error);
    }
  });

  router.post('/register', async (req, res, next) => {
    try {
      const body = req.body as { username?: unknown; password?: unknown };
      const result = await service.register(body.username, body.password);
      // Fork: record the setup event for the login-activity panel (best-effort).
      if (result?.user?.id != null) {
        loginEventsDb.recordEvent(result.user.id, {
          eventType: 'register',
          ipAddress: getClientIp(req),
          userAgent: req.headers['user-agent'] || null,
        });
      }
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const body = req.body as { username?: unknown; password?: unknown };
      const result = await service.login(body.username, body.password);
      // Fork: record the login event for the login-activity panel (best-effort).
      if (result?.user?.id != null) {
        loginEventsDb.recordEvent(result.user.id, {
          eventType: 'login',
          ipAddress: getClientIp(req),
          userAgent: req.headers['user-agent'] || null,
        });
      }
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/user', authenticateToken, (req, res) => {
    res.json(service.getCurrentUser((req as AuthenticatedRequest).user));
  });

  router.post('/refresh', authenticateToken, (req, res) => {
    res.json(service.refreshSession((req as AuthenticatedRequest).user));
  });

  router.post('/logout', authenticateToken, (_req, res) => {
    res.json(service.logout());
  });

  // Fork: currently-active chat WebSockets — the "Now" panel feed. Ephemeral,
  // in-memory, reset on server restart.
  router.get('/active-sessions', authenticateToken, (_req, res) => {
    res.json({ sessions: presence.list() });
  });

  // Fork: recent login activity for the shared single-user lab account. The IP
  // and user-agent are what differentiate one team member's session from another.
  router.get('/login-events', authenticateToken, (req, res, next) => {
    try {
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? ''), 10) || 50, 1), 200);
      res.json({ events: loginEventsDb.getRecentEvents(limit) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
