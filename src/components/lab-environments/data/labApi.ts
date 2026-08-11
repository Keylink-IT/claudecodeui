import { api } from '../../../utils/api';
import type {
  DropletsApiResponse,
  Ec2InstancesResponse,
  EnvironmentEntry,
  EnvironmentsApiResponse,
  InmotionAccountsResponse,
  InmotionServersResponse,
  VmsApiResponse,
} from '../types';

const parseJson = async <T>(response: Response): Promise<T> => {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    const text = await response.text();
    throw new Error(
      `Server returned non-JSON response (HTTP ${response.status}): ${text.slice(0, 200)}`,
    );
  }
  const data = (await response.json()) as T;
  return data;
};

export async function fetchProjectEnvironments(projectName: string): Promise<EnvironmentsApiResponse> {
  const response = await api.get(`/lab/projects/${encodeURIComponent(projectName)}/environments`);
  const data = await parseJson<EnvironmentsApiResponse & { error?: string }>(response);
  if (!response.ok) throw new Error(data.error || 'Failed to load environments');
  return data;
}

export async function saveProjectEnvironments(
  projectName: string,
  patch: { production?: EnvironmentEntry; development?: EnvironmentEntry },
): Promise<EnvironmentsApiResponse> {
  const response = await api.put(
    `/lab/projects/${encodeURIComponent(projectName)}/environments`,
    patch,
  );
  const data = await parseJson<EnvironmentsApiResponse & { error?: string }>(response);
  if (!response.ok) throw new Error(data.error || 'Failed to save environments');
  return data;
}

export async function fetchDroplets(forceRefresh = false): Promise<DropletsApiResponse> {
  const url = forceRefresh ? '/lab/droplets?refresh=1' : '/lab/droplets';
  const response = await api.get(url);
  const data = await parseJson<DropletsApiResponse & { error?: string; details?: string }>(response);
  if (!response.ok) throw new Error(data.error || data.details || 'Failed to list droplets');
  return data;
}

export async function fetchVms(forceRefresh = false): Promise<VmsApiResponse> {
  const url = forceRefresh ? '/lab/vms?refresh=1' : '/lab/vms';
  const response = await api.get(url);
  const data = await parseJson<VmsApiResponse & { error?: string; details?: string }>(response);
  if (!response.ok) throw new Error(data.error || data.details || 'Failed to list VMs');
  return data;
}

export async function fetchInmotionServers(forceRefresh = false): Promise<InmotionServersResponse> {
  const url = forceRefresh ? '/lab/inmotion/servers?refresh=1' : '/lab/inmotion/servers';
  const response = await api.get(url);
  const data = await parseJson<InmotionServersResponse & { error?: string }>(response);
  if (!response.ok) throw new Error(data.error || 'Failed to list WHM servers');
  return data;
}

export async function fetchInmotionAccounts(server: string, forceRefresh = false): Promise<InmotionAccountsResponse> {
  const params = new URLSearchParams({ server });
  if (forceRefresh) params.set('refresh', '1');
  const response = await api.get(`/lab/inmotion/accounts?${params.toString()}`);
  const data = await parseJson<InmotionAccountsResponse & { error?: string }>(response);
  if (!response.ok) throw new Error(data.error || 'Failed to list cPanel accounts');
  return data;
}

export async function fetchEc2Instances(region?: string, forceRefresh = false): Promise<Ec2InstancesResponse> {
  const params = new URLSearchParams();
  if (region) params.set('region', region);
  if (forceRefresh) params.set('refresh', '1');
  const qs = params.toString();
  const response = await api.get(`/lab/ec2/instances${qs ? `?${qs}` : ''}`);
  const data = await parseJson<Ec2InstancesResponse & { error?: string }>(response);
  if (!response.ok) throw new Error(data.error || 'Failed to list EC2 instances');
  return data;
}
