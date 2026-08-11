import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { DEFAULT_GITEA_ORG, GITEA_URL, giteaFetch } from './giteaClient.js';

const router = express.Router();

function summarizeRepo(repo) {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    html_url: repo.html_url,
    clone_url: repo.clone_url,
    ssh_url: repo.ssh_url,
    private: repo.private,
    description: repo.description || '',
    default_branch: repo.default_branch || 'main',
    empty: repo.empty === true,
  };
}

// GET /api/gitea/repos?q=&limit=
// Search repos visible to the configured Gitea token.
router.get('/repos', authenticateToken, async (req, res) => {
  try {
    const q = (req.query.q || '').toString();
    const limitRaw = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 50) : 20;

    const params = new URLSearchParams({ limit: String(limit) });
    if (q.trim()) params.set('q', q.trim());

    const giteaRes = await giteaFetch(`/repos/search?${params.toString()}`);
    if (!giteaRes.ok) {
      const text = await giteaRes.text();
      return res.status(502).json({ error: 'Gitea search failed', details: text });
    }
    const data = await giteaRes.json();
    const repos = Array.isArray(data?.data) ? data.data.map(summarizeRepo) : [];
    return res.json({ repos, defaultOrg: DEFAULT_GITEA_ORG, baseUrl: GITEA_URL });
  } catch (error) {
    console.error('Gitea repo search error:', error);
    return res.status(500).json({ error: 'Failed to search Gitea repos', message: error.message });
  }
});

// POST /api/gitea/repos
// Body: { name, org?, private?, description?, autoInit? }
router.post('/repos', authenticateToken, async (req, res) => {
  try {
    const { name, org, description = '', autoInit = true } = req.body || {};
    const isPrivate = req.body?.private === true;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name is required' });
    }
    const safeName = name.trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(safeName)) {
      return res.status(400).json({ error: 'name must contain only letters, digits, _, ., or -' });
    }

    const owner = (org || DEFAULT_GITEA_ORG).trim();
    const endpoint = owner ? `/orgs/${encodeURIComponent(owner)}/repos` : '/user/repos';

    const giteaRes = await giteaFetch(endpoint, {
      method: 'POST',
      body: JSON.stringify({
        name: safeName,
        description,
        private: isPrivate,
        auto_init: autoInit,
        default_branch: 'main',
      }),
    });

    if (giteaRes.ok) {
      const repo = await giteaRes.json();
      return res.status(201).json({ repo: summarizeRepo(repo), created: true });
    }

    // Already exists — return the existing repo so the wizard can reuse it.
    if (giteaRes.status === 409) {
      const lookup = await giteaFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(safeName)}`);
      if (lookup.ok) {
        const repo = await lookup.json();
        return res.status(200).json({ repo: summarizeRepo(repo), created: false });
      }
    }

    const text = await giteaRes.text();
    return res.status(502).json({
      error: 'Gitea create-repo failed',
      status: giteaRes.status,
      details: text,
    });
  } catch (error) {
    console.error('Gitea repo create error:', error);
    return res.status(500).json({ error: 'Failed to create Gitea repo', message: error.message });
  }
});

export default router;
