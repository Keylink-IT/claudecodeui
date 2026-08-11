export type EnvironmentSlot = 'production' | 'development';

// Optional rich-doc fields any environment entry can carry. Read by AI
// sessions alongside the connection fields; the picker UI doesn't edit
// these (users set them via the /assign-environments slash command or
// directly in .lab/environments.json).
export type EnvironmentExtras = {
  services?: Array<{ name: string; port?: number; restart?: string }>;
  urls?: Record<string, string>;
  deploy_notes?: string;
};

export type DropletEntry = EnvironmentExtras & {
  kind: 'do_droplet';
  id: number | null;
  name: string | null;
  region?: string | null;
  ip?: string | null;
};

export type Kitvm3Entry = EnvironmentExtras & {
  kind: 'kitvm3_vm';
  name: string;
  state?: number | null;
};

export type InmotionEntry = EnvironmentExtras & {
  kind: 'inmotion_cpanel';
  server: string;       // vault slug, e.g. "whm01"
  account: string;      // cPanel username
  domain?: string | null;
  ip?: string | null;
  home_path?: string;
};

export type Ec2Entry = EnvironmentExtras & {
  kind: 'ec2_instance';
  instance_id: string;
  region: string;
  public_ip: string;
  ssh_user: string;
  ssh_key_path: string;     // relative to project root, gitignored
  code_path?: string | null;
};

export type EnvironmentEntry =
  | DropletEntry
  | Kitvm3Entry
  | InmotionEntry
  | Ec2Entry
  | null;

export type ProjectEnvironments = {
  production: EnvironmentEntry;
  development: EnvironmentEntry;
};

export type DropletSummary = {
  id: number;
  name: string;
  status: string;
  region: string | null;
  size: string | null;
  ip: string | null;
  tags: string[];
};

export type Kitvm3VmSummary = {
  name: string;
  state: number | null;
  memory_bytes: number | null;
  vcpus: number | null;
};

export type EnvironmentsApiResponse = {
  projectPath: string;
  environments: ProjectEnvironments;
};

export type DropletsApiResponse = {
  droplets: DropletSummary[];
  cached: boolean;
  fetchedAt: number;
};

export type VmsApiResponse = {
  vms: Kitvm3VmSummary[];
  cached: boolean;
  fetchedAt: number;
};

export type InmotionServerSummary = {
  slug: string;          // vault item suffix, e.g. "whm01"
  host: string | null;   // WHM hostname extracted from the vault item's URI
};

export type InmotionAccountSummary = {
  user: string;          // cPanel username
  domain: string;
  ip: string;
  owner: string;
  plan: string;
  suspended: boolean;
};

export type InmotionServersResponse = {
  servers: InmotionServerSummary[];
  cached: boolean;
  fetchedAt: number;
};

export type InmotionAccountsResponse = {
  server: string;
  accounts: InmotionAccountSummary[];
  cached: boolean;
  fetchedAt: number;
};

export type Ec2InstanceSummary = {
  instance_id: string;
  name: string | null;
  state: string;
  instance_type: string;
  public_ip: string | null;
  private_ip: string | null;
  key_name: string | null;
  availability_zone: string | null;
  tags: Record<string, string>;
};

export type Ec2InstancesResponse = {
  region: string;
  defaultRegion: string;
  instances: Ec2InstanceSummary[];
  cached: boolean;
  fetchedAt: number;
};
