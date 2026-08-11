import fs from 'fs';
import os from 'os';
import path from 'path';

export const GITEA_URL = 'https://git.keylinkit.net';
export const DEFAULT_GITEA_ORG = 'keylink-studio';

// Parse the Gitea personal access token from the git credentials file.
// Format: https://<user>:<token>@git.keylinkit.net
export function getGiteaToken() {
  const credPaths = [
    path.join(os.homedir(), '.config', 'git', 'credentials'),
    path.join(os.homedir(), '.git-credentials'),
  ];
  for (const p of credPaths) {
    try {
      const content = fs.readFileSync(p, 'utf-8');
      const match = content.match(/https?:\/\/[^:]+:([^@]+)@git\.keylinkit\.net/);
      if (match) return match[1];
    } catch {
      // try next path
    }
  }
  return null;
}

export async function giteaFetch(endpoint, options = {}) {
  const token = getGiteaToken();
  if (!token) throw new Error('Gitea token not found in git credentials');

  const res = await fetch(`${GITEA_URL}/api/v1${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `token ${token}`,
      ...options.headers,
    },
  });
  return res;
}
