import { api, getStoredAuthToken } from '../../../utils/api';
import type { EnvironmentEntry } from '../../lab-environments/types';
import type {
  BrowseFilesystemResponse,
  CloneProgressEvent,
  ConsoleProjectSelection,
  CreateFolderResponse,
  CreateProjectPayload,
  CreateProjectResponse,
  CredentialsResponse,
  FolderSuggestion,
  GitRemoteMode,
  GiteaRepoSearchResponse,
  GiteaRepoSummary,
  TokenMode,
  WorkspaceType,
} from '../types';

type CloneWorkspaceParams = {
  workspacePath: string;
  githubUrl: string;
  tokenMode: TokenMode;
  selectedGithubToken: string;
  newGithubToken: string;
};

type CreateWithGitParams = {
  workspaceType: WorkspaceType;
  workspacePath: string;
  prdProjectName: string;
  gitRemoteMode: GitRemoteMode;
  gitCreateName: string;
  gitCreateOrg: string;
  gitCreatePrivate: boolean;
  gitPickedRepo: GiteaRepoSummary | null;
  consoleProject: ConsoleProjectSelection | null;
  prodEnvironment: EnvironmentEntry;
  devEnvironment: EnvironmentEntry;
};

type ProgressHandlers = {
  onProgress: (message: string) => void;
};

type CreateWithGitResult = {
  project?: Record<string, unknown>;
  workspaceType?: WorkspaceType;
  remote?: { full_name: string; html_url: string } | null;
};

const parseJson = async <T>(response: Response): Promise<T> => {
  const data = (await response.json()) as T;
  return data;
};

// Upstream 1.33 error-shape unwrapper for the native create-project endpoint.
const resolveCreateProjectErrorMessage = (responseData: CreateProjectResponse): string | null => {
  if (typeof responseData.details === 'string' && responseData.details.trim().length > 0) {
    return responseData.details;
  }

  if (typeof responseData.error === 'string' && responseData.error.trim().length > 0) {
    return responseData.error;
  }

  if (responseData.error && typeof responseData.error === 'object') {
    const errorObject = responseData.error as { message?: unknown; details?: unknown };

    if (typeof errorObject.details === 'string' && errorObject.details.trim().length > 0) {
      return errorObject.details;
    }

    if (typeof errorObject.message === 'string' && errorObject.message.trim().length > 0) {
      return errorObject.message;
    }

    if (
      errorObject.details
      && typeof errorObject.details === 'object'
      && typeof (errorObject.details as { projectPath?: unknown }).projectPath === 'string'
    ) {
      return `Project path already exists: ${(errorObject.details as { projectPath: string }).projectPath}`;
    }
  }

  if (typeof responseData.message === 'string' && responseData.message.trim().length > 0) {
    return responseData.message;
  }

  return null;
};

export const fetchGithubTokenCredentials = async () => {
  const response = await api.get('/settings/credentials?type=github_token');
  const data = await parseJson<CredentialsResponse>(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to load GitHub tokens');
  }

  return (data.credentials || []).filter((credential) => credential.is_active);
};

export const browseFilesystemFolders = async (pathToBrowse: string) => {
  const endpoint = `/file-tree/browse-filesystem?path=${encodeURIComponent(pathToBrowse)}`;
  const response = await api.get(endpoint);
  const data = await parseJson<BrowseFilesystemResponse>(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to browse filesystem');
  }

  return {
    path: data.path || pathToBrowse,
    suggestions: (data.suggestions || []) as FolderSuggestion[],
  };
};

export const createFolderInFilesystem = async (folderPath: string) => {
  const response = await api.createFolder(folderPath);
  const data = await parseJson<CreateFolderResponse>(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to create folder');
  }

  return data.path || folderPath;
};

// Native 1.33 "create empty project" (POST /api/projects -> createProject).
// Retained from upstream for parity; the wizard's create flow uses the
// streaming createWithGitProgress below.
export const createProjectRequest = async (payload: CreateProjectPayload) => {
  const response = await api.createProject(payload);
  const data = await parseJson<CreateProjectResponse>(response);

  if (!response.ok) {
    throw new Error(resolveCreateProjectErrorMessage(data) || 'Failed to create project');
  }

  return data.project;
};

export const searchGiteaRepos = async (query: string) => {
  const params = new URLSearchParams();
  if (query.trim()) params.set('q', query.trim());
  const response = await api.get(`/gitea/repos?${params.toString()}`);
  const data = await parseJson<GiteaRepoSearchResponse>(response);

  if (!response.ok) {
    throw new Error(data.details || data.error || 'Failed to search Gitea repos');
  }

  return {
    repos: data.repos || [],
    defaultOrg: data.defaultOrg || 'keylink-studio',
  };
};

const buildCloneProgressQuery = ({
  workspacePath,
  githubUrl,
  tokenMode,
  selectedGithubToken,
  newGithubToken,
}: CloneWorkspaceParams) => {
  const query = new URLSearchParams({
    path: workspacePath.trim(),
    githubUrl: githubUrl.trim(),
  });

  if (tokenMode === 'stored' && selectedGithubToken) {
    query.set('githubTokenId', selectedGithubToken);
  }

  if (tokenMode === 'new' && newGithubToken.trim()) {
    query.set('newGithubToken', newGithubToken.trim());
  }

  // EventSource cannot send custom headers, so the auth token is passed as query.
  const authToken = getStoredAuthToken();
  if (authToken) {
    query.set('token', authToken);
  }

  return query.toString();
};

export const cloneWorkspaceWithProgress = (
  params: CloneWorkspaceParams,
  handlers: ProgressHandlers,
) =>
  new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
    const query = buildCloneProgressQuery(params);
    const eventSource = new EventSource(`/api/projects/clone-progress?${query}`);
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      eventSource.close();
      callback();
    };

    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as CloneProgressEvent;

        if (payload.type === 'progress' && payload.message) {
          handlers.onProgress(payload.message);
          return;
        }

        if (payload.type === 'complete') {
          settle(() => resolve(payload.project));
          return;
        }

        if (payload.type === 'error') {
          settle(() => reject(new Error(payload.message || 'Failed to clone repository')));
        }
      } catch (error) {
        console.error('Error parsing clone progress event:', error);
      }
    };

    eventSource.onerror = () => {
      settle(() => reject(new Error('Connection lost during clone')));
    };
  });

export const createWithGitProgress = (
  params: CreateWithGitParams,
  handlers: ProgressHandlers,
) =>
  new Promise<CreateWithGitResult>((resolve, reject) => {
    const query = new URLSearchParams({
      workspaceType: params.workspaceType,
      gitRemoteMode: params.gitRemoteMode,
    });
    if (params.workspacePath.trim()) query.set('workspacePath', params.workspacePath.trim());
    if (params.prdProjectName.trim()) query.set('prdProjectName', params.prdProjectName.trim());
    if (params.gitRemoteMode === 'create') {
      query.set('gitCreateName', params.gitCreateName.trim());
      query.set('gitCreateOrg', params.gitCreateOrg.trim());
      query.set('gitCreatePrivate', params.gitCreatePrivate ? 'true' : 'false');
    }
    if (params.gitRemoteMode === 'pick' && params.gitPickedRepo) {
      query.set('gitPickedRepoFullName', params.gitPickedRepo.full_name);
    }
    if (params.consoleProject?.id) {
      query.set('consoleProjectId', params.consoleProject.id);
      query.set('consoleProjectName', params.consoleProject.name || '');
    }
    // Environments — JSON-encoded because the entries carry richer per-kind
    // shape (ssh_user, server slug, etc.) than the flat consoleProject params.
    if (params.prodEnvironment) {
      query.set('prodEnvironment', JSON.stringify(params.prodEnvironment));
    }
    if (params.devEnvironment) {
      query.set('devEnvironment', JSON.stringify(params.devEnvironment));
    }

    const authToken = localStorage.getItem('auth-token');
    if (authToken) query.set('token', authToken);

    const eventSource = new EventSource(`/api/projects/create-with-git?${query.toString()}`);
    let settled = false;

    const settle = (cb: () => void) => {
      if (settled) return;
      settled = true;
      eventSource.close();
      cb();
    };

    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as CloneProgressEvent & CreateWithGitResult;

        if (payload.type === 'progress' && payload.message) {
          handlers.onProgress(payload.message);
          return;
        }

        if (payload.type === 'complete') {
          settle(() =>
            resolve({
              project: payload.project,
              workspaceType: payload.workspaceType,
              remote: payload.remote,
            }),
          );
          return;
        }

        if (payload.type === 'error') {
          settle(() => reject(new Error(payload.message || 'Failed to create project')));
        }
      } catch (error) {
        console.error('Error parsing create-with-git event:', error);
      }
    };

    eventSource.onerror = () => {
      settle(() => reject(new Error('Connection lost during project creation')));
    };
  });
