import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { GITEA_URL, giteaFetch } from './giteaClient.js';

const router = express.Router();

const GITEA_ORG = 'keylink-studio';
const PRD_REPO = 'forge-prds';

// Ensure the forge-prds repo exists under the org. Idempotent.
async function ensureRepo() {
  const check = await giteaFetch(`/repos/${GITEA_ORG}/${PRD_REPO}`);
  if (check.ok) return;

  // Try to create it
  const create = await giteaFetch(`/orgs/${GITEA_ORG}/repos`, {
    method: 'POST',
    body: JSON.stringify({
      name: PRD_REPO,
      description: 'PRDs submitted from the lab for the Forge pipeline',
      private: false,
      auto_init: true,
      default_branch: 'main',
    }),
  });

  if (!create.ok && create.status !== 409) {
    const err = await create.text();
    throw new Error(`Failed to create repo ${GITEA_ORG}/${PRD_REPO}: ${create.status} ${err}`);
  }
}

// Push or update a file in the repo via the Gitea Contents API.
async function pushFile(filePath, content, message) {
  // Check if file already exists (need its SHA to update)
  const existing = await giteaFetch(`/repos/${GITEA_ORG}/${PRD_REPO}/contents/${encodeURIComponent(filePath)}?ref=main`);
  const body = {
    message,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch: 'main',
  };

  if (existing.ok) {
    const data = await existing.json();
    body.sha = data.sha;
  }

  const res = await giteaFetch(`/repos/${GITEA_ORG}/${PRD_REPO}/contents/${encodeURIComponent(filePath)}`, {
    method: existing.ok ? 'PUT' : 'POST',
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to push ${filePath}: ${res.status} ${err}`);
  }

  return res.json();
}

// POST /api/forge/submit
// Body: { fileName: string, content: string }
router.post('/submit', authenticateToken, async (req, res) => {
  try {
    const { fileName, content } = req.body;

    if (!fileName || !content) {
      return res.status(400).json({ error: 'fileName and content are required' });
    }

    // Sanitize filename
    const safeName = fileName.replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/\.+/g, '.');
    const filePath = `prds/${safeName}.md`;
    const commitMessage = `Submit PRD: ${safeName}`;

    await ensureRepo();
    const result = await pushFile(filePath, content, commitMessage);

    const repoUrl = `${GITEA_URL}/${GITEA_ORG}/${PRD_REPO}`;
    const fileUrl = `${repoUrl}/src/branch/main/${filePath}`;

    res.json({
      success: true,
      repoUrl,
      fileUrl,
      filePath,
      message: `PRD submitted to ${GITEA_ORG}/${PRD_REPO}`,
    });
  } catch (error) {
    console.error('Forge submit error:', error);
    res.status(500).json({
      error: 'Failed to submit PRD to Forge',
      message: error.message,
    });
  }
});

export default router;
