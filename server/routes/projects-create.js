import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import os from 'os';
import { createProject } from '../modules/projects/services/project-management.service.js';
import { validateWorkspacePath } from '../shared/utils.js';
import { DEFAULT_GITEA_ORG, GITEA_URL, getGiteaToken, giteaFetch } from './giteaClient.js';
import { PRD_CLAUDE_MD } from '../templates/prdClaudeMd.js';
import { PRD_SLASH_COMMANDS } from '../templates/prdSlashCommands.js';

const router = express.Router();

// Redact a Gitea token from any text we echo back to the client. Ported from
// the 1.28 routes/projects.js helper (the rest of that file became the 1.33
// modules/projects/* services; only the wizard's create-with-git flow is ours).
function sanitizeGitError(message, token) {
  if (!message || !token) return message;
  return message.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '***');
}

/**
 * Streaming endpoint for the Pivot 3 wizard's universal "create-with-git" flow.
 *
 * Handles three workspace types crossed with three remote modes (create / pick / none).
 * The "external" remote mode keeps using the existing /clone-progress endpoint, so we
 * don't replicate its logic here.
 *
 * GET /api/projects/create-with-git
 * Query: workspaceType, workspacePath?, prdProjectName?, gitRemoteMode,
 *        gitCreateName?, gitCreateOrg?, gitCreatePrivate?, gitPickedRepoFullName?, token
 */
router.get('/create-with-git', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (type, data = {}) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  const fail = (message) => {
    sendEvent('error', { message });
    res.end();
  };

  try {
    const {
      workspaceType,
      workspacePath: rawPath,
      prdProjectName,
      gitRemoteMode,
      gitCreateName,
      gitCreateOrg,
      gitCreatePrivate,
      gitPickedRepoFullName,
      consoleProjectId,
      consoleProjectName,
      prodEnvironment: prodEnvironmentRaw,
      devEnvironment: devEnvironmentRaw,
    } = req.query;

    // Console board linkage — surfaced to scaffolding so .lab/console-project.json
    // gets written when the user picked or created a Console project in the wizard.
    const consoleProject = (consoleProjectId && String(consoleProjectId).trim())
      ? { id: String(consoleProjectId).trim(), name: (consoleProjectName || '').trim() }
      : null;

    // Environment picks (Prod/Dev) — wizard sends each entry JSON-encoded, or
    // omits the param entirely if the slot was left empty. Malformed JSON falls
    // back to null silently rather than failing the create.
    const parseEnvParam = (raw) => {
      if (!raw) return null;
      try {
        const parsed = JSON.parse(String(raw));
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch {
        return null;
      }
    };
    const prodEnvironment = parseEnvParam(prodEnvironmentRaw);
    const devEnvironment = parseEnvParam(devEnvironmentRaw);

    if (!['existing', 'new', 'from-prd'].includes(workspaceType)) {
      return fail('workspaceType must be existing, new, or from-prd');
    }
    if (!['create', 'pick', 'none'].includes(gitRemoteMode)) {
      return fail('gitRemoteMode must be create, pick, or none');
    }

    // Resolve target workspace path.
    let targetPath;
    if (workspaceType === 'from-prd') {
      const slug = slugifyProjectName(prdProjectName || '');
      if (!slug) return fail('Project name is required for from-prd');
      const root = process.env.WORKSPACES_ROOT || path.join(os.homedir(), 'workspace');
      targetPath = path.join(root, slug);
    } else {
      if (!rawPath || !rawPath.trim()) return fail('workspacePath is required');
      targetPath = rawPath.trim();
    }

    const validation = await validateWorkspacePath(targetPath);
    if (!validation.valid) return fail(validation.error);
    const absolutePath = validation.resolvedPath;

    // Pre-resolve the Gitea remote (create or pick) before touching disk so we can
    // surface remote-side errors without leaving partial workspace state behind.
    let remote = null;
    const giteaToken = getGiteaToken();

    if (gitRemoteMode === 'create') {
      const safeName = (gitCreateName || '').trim();
      if (!/^[A-Za-z0-9_.-]+$/.test(safeName)) {
        return fail('Repo name must contain only letters, digits, _, ., or -');
      }
      const owner = (gitCreateOrg || DEFAULT_GITEA_ORG).trim() || DEFAULT_GITEA_ORG;
      sendEvent('progress', { message: `Creating ${owner}/${safeName} on Gitea…` });

      const created = await giteaCreateOrReuseRepo({
        owner,
        name: safeName,
        isPrivate: gitCreatePrivate === 'true' || gitCreatePrivate === true,
      });
      if (!created.ok) return fail(created.error);
      remote = created.repo;
    } else if (gitRemoteMode === 'pick') {
      const fullName = (gitPickedRepoFullName || '').trim();
      if (!fullName.includes('/')) return fail('gitPickedRepoFullName must be "owner/name"');
      const lookup = await giteaFetch(`/repos/${fullName.split('/').map(encodeURIComponent).join('/')}`);
      if (!lookup.ok) return fail(`Picked repo not found: ${fullName}`);
      remote = await lookup.json();
    }

    // Build the authenticated clone/push URL once. Gitea over HTTPS uses the embedded
    // token via the `token` username convention used by the existing kitadmin helper.
    const remoteUrlWithAuth = remote && giteaToken
      ? authenticateGiteaUrl(remote.clone_url, giteaToken)
      : null;

    // Create / verify the workspace dir.
    if (workspaceType === 'existing') {
      try {
        const stats = await fs.stat(absolutePath);
        if (!stats.isDirectory()) return fail('Path exists but is not a directory');
      } catch (error) {
        if (error.code === 'ENOENT') return fail('Workspace path does not exist');
        throw error;
      }
    } else {
      // new + from-prd: ensure parent exists, create dir if missing.
      try {
        await fs.access(absolutePath);
        const stats = await fs.stat(absolutePath);
        if (stats.isDirectory()) {
          const entries = await fs.readdir(absolutePath);
          if (entries.length > 0 && gitRemoteMode === 'pick') {
            return fail(`Target directory ${absolutePath} is not empty; pick requires an empty target`);
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await fs.mkdir(absolutePath, { recursive: true });
      }
    }

    const isFromPrd = workspaceType === 'from-prd';

    // Run the git plumbing for the chosen mode.
    if (gitRemoteMode === 'pick' && (workspaceType === 'new' || workspaceType === 'from-prd')) {
      sendEvent('progress', { message: `Cloning ${remote.full_name}…` });
      // Clone INTO the workspace dir (it must be empty).
      const cloneResult = await runGit(['clone', '--progress', remoteUrlWithAuth, absolutePath], {
        sendEvent,
        token: giteaToken,
      });
      if (!cloneResult.ok) return fail(cloneResult.error);

      // Add PRD scaffolding on top of the cloned content as a separate commit.
      if (isFromPrd) {
        sendEvent('progress', { message: 'Scaffolding PRD project…' });
        await scaffoldFromPrdProject(absolutePath, { consoleProject, prodEnvironment, devEnvironment });
        const scaffoldCommit = await commitScaffoldingChanges(absolutePath, sendEvent);
        if (!scaffoldCommit.ok) return fail(scaffoldCommit.error);
        sendEvent('progress', { message: 'Pushing PRD scaffolding…' });
        const push = await runGit(['push', '-u', 'origin', 'HEAD'], {
          cwd: absolutePath,
          sendEvent,
          token: giteaToken,
        });
        if (!push.ok) return fail(push.error);
      }
    } else if (gitRemoteMode === 'create' || gitRemoteMode === 'pick' || gitRemoteMode === 'none') {
      // existing-* and new/from-prd-create/none all need a local repo first.
      const gitDir = path.join(absolutePath, '.git');
      const hasGitDir = await fs
        .access(gitDir)
        .then(() => true)
        .catch(() => false);

      if (!hasGitDir) {
        sendEvent('progress', { message: 'Initializing git repo…' });
        const initResult = await runGit(['init', '-b', 'main'], { cwd: absolutePath, sendEvent });
        if (!initResult.ok) return fail(initResult.error);
      }

      // PRD scaffolding for from-prd lands BEFORE remote add so the initial
      // commit (create mode) naturally picks it up.
      if (isFromPrd) {
        sendEvent('progress', { message: 'Scaffolding PRD project…' });
        await scaffoldFromPrdProject(absolutePath, { consoleProject, prodEnvironment, devEnvironment });
      }

      if (remote) {
        // Replace any existing 'origin' so re-runs don't fail.
        await runGit(['remote', 'remove', 'origin'], { cwd: absolutePath, ignoreError: true });
        const addRemote = await runGit(['remote', 'add', 'origin', remoteUrlWithAuth], {
          cwd: absolutePath,
          sendEvent,
          token: giteaToken,
        });
        if (!addRemote.ok) return fail(addRemote.error);

        // Seed initial commit only for create-mode + workspace was empty.
        if (gitRemoteMode === 'create' && (workspaceType === 'new' || workspaceType === 'from-prd')) {
          const readmePath = path.join(absolutePath, 'README.md');
          await fs.writeFile(readmePath, `# ${remote.name}\n\n${remote.description || ''}\n`, 'utf-8');

          await runGit(['add', '.'], { cwd: absolutePath, sendEvent });
          // Use a deterministic identity so commits work even if global git config is missing.
          const commitEnv = {
            GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'cloudcli',
            GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'cloudcli@local',
            GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'cloudcli',
            GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'cloudcli@local',
          };
          const commit = await runGit(['commit', '-m', 'Initial commit'], {
            cwd: absolutePath,
            sendEvent,
            extraEnv: commitEnv,
          });
          if (!commit.ok) return fail(commit.error);

          sendEvent('progress', { message: 'Pushing to origin…' });
          const push = await runGit(['push', '-u', 'origin', 'main'], {
            cwd: absolutePath,
            sendEvent,
            token: giteaToken,
          });
          if (!push.ok) return fail(push.error);
        }
      }
    }

    // Register the new workspace as a project (1.33: SQLite projectsDb via the
    // projects module's createProject — replaces the 1.28 addProjectManually).
    // The returned view is the native 1.33 project shape the wizard expects.
    const created = await createProject({ projectPath: absolutePath });
    const project = created.project;
    sendEvent('complete', {
      project,
      workspaceType,
      remote: remote
        ? {
            full_name: remote.full_name,
            html_url: remote.html_url || `${GITEA_URL}/${remote.full_name}`,
          }
        : null,
      message: 'Project created',
    });
    res.end();
  } catch (error) {
    console.error('create-with-git error:', error);
    return fail(error.message || 'Failed to create project');
  }
});

// PRD-project scaffolding: drop a CLAUDE.md (PRD-authoring system prompt), a
// minimal .taskmaster/ skeleton (so the Tasks tab detects the project), and a
// .claude/commands/ directory of project-scoped slash commands (/save-prd,
// /generate-tasks, /submit-to-forge, /push-to-console) the user can invoke
// from chat.
async function scaffoldFromPrdProject(
  workspacePath,
  { consoleProject = null, prodEnvironment = null, devEnvironment = null } = {},
) {
  // CLAUDE.md — only write if the workspace doesn't already have one.
  const claudeMdPath = path.join(workspacePath, 'CLAUDE.md');
  const claudeMdExists = await fs.access(claudeMdPath).then(() => true).catch(() => false);
  if (!claudeMdExists) {
    await fs.writeFile(claudeMdPath, PRD_CLAUDE_MD, 'utf-8');
  }

  // .lab/environments.json — seeded with whatever the user picked in the
  // wizard's Environments step (or nulls if skipped). Discoverable by the
  // cloudcli UI's header pills and the lab-environments MCP server. Operator
  // (or Claude via /assign-environments) can change these later.
  const labDir = path.join(workspacePath, '.lab');
  await fs.mkdir(labDir, { recursive: true });
  const labEnvFile = path.join(labDir, 'environments.json');
  const labEnvExists = await fs.access(labEnvFile).then(() => true).catch(() => false);
  if (!labEnvExists) {
    await fs.writeFile(
      labEnvFile,
      JSON.stringify(
        { production: prodEnvironment ?? null, development: devEnvironment ?? null },
        null,
        2,
      ) + '\n',
      'utf-8',
    );
  }

  // .lab/console-project.json — link to the Console board (console.keylinkit.com)
  // selected during the wizard. Read by /push-to-console to know which project to
  // POST tasks to. Skipped when the user opted out in the wizard.
  if (consoleProject && consoleProject.id) {
    const consoleProjectFile = path.join(labDir, 'console-project.json');
    const consoleProjectExists = await fs.access(consoleProjectFile).then(() => true).catch(() => false);
    if (!consoleProjectExists) {
      await fs.writeFile(
        consoleProjectFile,
        JSON.stringify({
          id: String(consoleProject.id),
          name: consoleProject.name || '',
          linked_at: new Date().toISOString(),
        }, null, 2) + '\n',
        'utf-8',
      );
    }
  }

  // .taskmaster/ skeleton.
  const taskmasterDir = path.join(workspacePath, '.taskmaster');
  await fs.mkdir(path.join(taskmasterDir, 'docs'), { recursive: true });
  await fs.mkdir(path.join(taskmasterDir, 'tasks'), { recursive: true });

  const tasksJsonPath = path.join(taskmasterDir, 'tasks', 'tasks.json');
  const tasksJsonExists = await fs.access(tasksJsonPath).then(() => true).catch(() => false);
  if (!tasksJsonExists) {
    await fs.writeFile(
      tasksJsonPath,
      JSON.stringify({ master: { tasks: [] } }, null, 2) + '\n',
      'utf-8',
    );
  }

  // .claude/commands/ — project-scoped slash commands. Each .md file is sent to
  // Claude as the prompt when the matching /command is invoked. Idempotent —
  // existing files are left alone so user customizations survive re-runs.
  const commandsDir = path.join(workspacePath, '.claude', 'commands');
  await fs.mkdir(commandsDir, { recursive: true });
  for (const [filename, content] of Object.entries(PRD_SLASH_COMMANDS)) {
    const cmdPath = path.join(commandsDir, filename);
    const cmdExists = await fs.access(cmdPath).then(() => true).catch(() => false);
    if (!cmdExists) {
      await fs.writeFile(cmdPath, content, 'utf-8');
    }
  }
}

// Stage + commit any scaffolding diffs (called after a clone for the pick path).
async function commitScaffoldingChanges(workspacePath, sendEvent) {
  const add = await runGit(['add', 'CLAUDE.md', '.taskmaster', '.claude', '.lab'], { cwd: workspacePath, sendEvent });
  if (!add.ok) return add;

  // Bail cleanly if there's nothing to commit (e.g. cloned repo already had it).
  const diff = await runGit(['diff', '--cached', '--quiet'], { cwd: workspacePath, ignoreError: true });
  if (diff.ok) return { ok: true };

  const commitEnv = {
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'cloudcli',
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'cloudcli@local',
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'cloudcli',
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'cloudcli@local',
  };
  return runGit(['commit', '-m', 'Add PRD authoring scaffolding'], {
    cwd: workspacePath,
    sendEvent,
    extraEnv: commitEnv,
  });
}

function slugifyProjectName(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

async function giteaCreateOrReuseRepo({ owner, name, isPrivate }) {
  try {
    const create = await giteaFetch(`/orgs/${encodeURIComponent(owner)}/repos`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: '',
        private: isPrivate,
        auto_init: false,
        default_branch: 'main',
      }),
    });

    if (create.ok) return { ok: true, repo: await create.json() };

    if (create.status === 409) {
      const lookup = await giteaFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
      if (lookup.ok) return { ok: true, repo: await lookup.json() };
    }

    if (create.status === 404) {
      // Org doesn't exist; fall back to the authenticated user's namespace.
      const userCreate = await giteaFetch('/user/repos', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description: '',
          private: isPrivate,
          auto_init: false,
          default_branch: 'main',
        }),
      });
      if (userCreate.ok) return { ok: true, repo: await userCreate.json() };
    }

    const text = await create.text();
    return { ok: false, error: `Gitea create-repo failed (${create.status}): ${text}` };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function authenticateGiteaUrl(cloneUrl, token) {
  try {
    const url = new URL(cloneUrl);
    url.username = encodeURIComponent('kitadmin');
    url.password = token;
    return url.toString();
  } catch {
    return cloneUrl;
  }
}

function runGit(args, { cwd, sendEvent, token, ignoreError = false, extraEnv = {} } = {}) {
  return new Promise((resolve) => {
    const proc = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...extraEnv,
        GIT_TERMINAL_PROMPT: '0',
      },
    });

    let stderr = '';

    const sanitize = (text) => (token ? sanitizeGitError(text, token) : text);

    proc.stdout.on('data', (data) => {
      const message = sanitize(data.toString().trim());
      if (message && sendEvent) sendEvent('progress', { message });
    });

    proc.stderr.on('data', (data) => {
      const raw = data.toString();
      stderr += raw;
      const message = sanitize(raw.trim());
      if (message && sendEvent) sendEvent('progress', { message });
    });

    proc.on('close', (code) => {
      if (code === 0) return resolve({ ok: true });
      if (ignoreError) return resolve({ ok: true });
      const sanitized = sanitize(stderr).trim() || `git ${args[0]} exited with code ${code}`;
      resolve({ ok: false, error: sanitized });
    });

    proc.on('error', (err) => {
      if (err.code === 'ENOENT') return resolve({ ok: false, error: 'git is not installed or not in PATH' });
      resolve({ ok: false, error: err.message });
    });
  });
}

export default router;
