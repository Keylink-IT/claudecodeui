import { api } from '../../../utils/api';
import type { ConsoleProject, ConsoleProjectListResponse } from '../types';

export const fetchConsoleProjects = async (
  query: string,
): Promise<ConsoleProject[]> => {
  const params = new URLSearchParams();
  const trimmed = query.trim();
  if (trimmed) params.set('q', trimmed);
  params.set('limit', '50');

  const response = await api.get(`/console/projects?${params.toString()}`);
  const data = (await response.json()) as ConsoleProjectListResponse;

  if (!response.ok) {
    throw new Error(data.error || 'Failed to load Console projects');
  }
  return data.projects || [];
};

export const createConsoleProject = async (input: {
  name: string;
  description?: string;
  type?: 'dev' | 'client' | 'infra';
}): Promise<ConsoleProject> => {
  const response = await api.post('/console/projects', {
    name: input.name,
    description: input.description || '',
    type: input.type || 'dev',
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || data.details?.error || 'Failed to create Console project');
  }
  return data as ConsoleProject;
};
