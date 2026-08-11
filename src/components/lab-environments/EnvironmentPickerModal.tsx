import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Cloud, Loader2, RefreshCw, Server, Trash2, X } from 'lucide-react';
import { Button, Input } from '../../shared/view/ui';
import {
  fetchDroplets,
  fetchEc2Instances,
  fetchInmotionAccounts,
  fetchInmotionServers,
  fetchVms,
  saveProjectEnvironments,
} from './data/labApi';
import type {
  DropletSummary,
  Ec2InstanceSummary,
  EnvironmentEntry,
  EnvironmentSlot,
  InmotionAccountSummary,
  InmotionServerSummary,
  Kitvm3VmSummary,
  ProjectEnvironments,
} from './types';

type EnvironmentPickerModalProps = {
  // Commit-mode props: omit projectName + onSaved together to enter collect mode.
  // Commit mode writes to <project>/.lab/environments.json on pick.
  // Collect mode emits the picked entry via onPick and closes — the caller
  // (e.g. the project-creation wizard) decides what to do with it.
  projectName?: string;
  onSaved?: (updated: ProjectEnvironments) => void;
  onPick?: (entry: EnvironmentEntry) => void;
  slot: EnvironmentSlot;
  currentEntry: EnvironmentEntry;
  onClose: () => void;
};

type Kind = 'do_droplet' | 'kitvm3_vm' | 'inmotion_cpanel' | 'ec2_instance';

const TAB_META: Record<Kind, { label: string; subtitle: string }> = {
  do_droplet: { label: 'DigitalOcean', subtitle: 'Pick a DigitalOcean droplet.' },
  kitvm3_vm: { label: 'Hyper-V VM', subtitle: 'Pick a Hyper-V VM on KITVM3.' },
  inmotion_cpanel: { label: 'WHM/cPanel', subtitle: 'Pick a cPanel account on an Inmotion WHM server.' },
  ec2_instance: { label: 'AWS EC2', subtitle: 'Pick an EC2 instance; fill in the SSH details for this project.' },
};

const SLOT_TITLES: Record<EnvironmentSlot, string> = {
  production: 'Production environment',
  development: 'Development environment',
};

const KIND_ORDER: Kind[] = ['do_droplet', 'kitvm3_vm', 'inmotion_cpanel', 'ec2_instance'];

export default function EnvironmentPickerModal({
  projectName,
  slot,
  currentEntry,
  onClose,
  onSaved,
  onPick,
}: EnvironmentPickerModalProps) {
  const isProduction = slot === 'production';
  const collectMode = !projectName;

  // Active tab: start from currentEntry's kind, else a slot-appropriate default.
  const initialKind: Kind = (currentEntry?.kind as Kind | undefined)
    ?? (isProduction ? 'do_droplet' : 'kitvm3_vm');
  const [activeKind, setActiveKind] = useState<Kind>(initialKind);

  // Shared state.
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-kind data.
  const [droplets, setDroplets] = useState<DropletSummary[] | null>(null);
  const [vms, setVms] = useState<Kitvm3VmSummary[] | null>(null);
  const [whmServers, setWhmServers] = useState<InmotionServerSummary[] | null>(null);
  const [whmSelectedServer, setWhmSelectedServer] = useState<string | null>(
    currentEntry?.kind === 'inmotion_cpanel' ? currentEntry.server : null,
  );
  const [whmAccounts, setWhmAccounts] = useState<InmotionAccountSummary[] | null>(null);
  const [ec2Region, setEc2Region] = useState<string | null>(
    currentEntry?.kind === 'ec2_instance' ? currentEntry.region : null,
  );
  const [ec2DefaultRegion, setEc2DefaultRegion] = useState<string | null>(null);
  const [ec2Instances, setEc2Instances] = useState<Ec2InstanceSummary[] | null>(null);
  const [ec2SelectedInstance, setEc2SelectedInstance] = useState<Ec2InstanceSummary | null>(null);
  const [ec2SshUser, setEc2SshUser] = useState<string>(
    currentEntry?.kind === 'ec2_instance' ? currentEntry.ssh_user : 'ubuntu',
  );
  const [ec2SshKeyPath, setEc2SshKeyPath] = useState<string>(
    currentEntry?.kind === 'ec2_instance' ? currentEntry.ssh_key_path : './aws-key.pem',
  );
  const [ec2CodePath, setEc2CodePath] = useState<string>(
    currentEntry?.kind === 'ec2_instance' ? (currentEntry.code_path ?? '') : '',
  );

  const loadList = useCallback(async (forceRefresh = false) => {
    if (forceRefresh) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      switch (activeKind) {
        case 'do_droplet': {
          const res = await fetchDroplets(forceRefresh);
          setDroplets(res.droplets);
          break;
        }
        case 'kitvm3_vm': {
          const res = await fetchVms(forceRefresh);
          setVms(res.vms);
          break;
        }
        case 'inmotion_cpanel': {
          const res = await fetchInmotionServers(forceRefresh);
          setWhmServers(res.servers);
          // Auto-pick the first server if none selected yet (saves a click).
          if (!whmSelectedServer && res.servers.length > 0) {
            setWhmSelectedServer(res.servers[0].slug);
          }
          break;
        }
        case 'ec2_instance': {
          const res = await fetchEc2Instances(ec2Region ?? undefined, forceRefresh);
          setEc2Instances(res.instances);
          setEc2DefaultRegion(res.defaultRegion);
          if (!ec2Region) setEc2Region(res.region);
          break;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeKind, whmSelectedServer, ec2Region]);

  useEffect(() => {
    void loadList(false);
    // Reset search when changing tabs so a stale query doesn't filter the
    // new list invisibly.
    setSearch('');
  }, [activeKind, loadList]);

  // Second-step fetch for WHM: once a server is chosen, load its accounts.
  useEffect(() => {
    if (activeKind !== 'inmotion_cpanel' || !whmSelectedServer) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchInmotionAccounts(whmSelectedServer, false)
      .then((res) => { if (!cancelled) setWhmAccounts(res.accounts); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'failed'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activeKind, whmSelectedServer]);

  // ---------- save -------------------------------------------------------

  const persist = async (entry: EnvironmentEntry) => {
    if (collectMode) {
      onPick?.(entry);
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await saveProjectEnvironments(projectName as string, { [slot]: entry });
      onSaved?.(result.environments);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
      setSaving(false);
    }
  };

  const isCurrent = (entry: EnvironmentEntry): boolean => {
    if (!currentEntry || !entry) return false;
    if (currentEntry.kind === 'do_droplet' && entry.kind === 'do_droplet') {
      return currentEntry.id === entry.id;
    }
    if (currentEntry.kind === 'kitvm3_vm' && entry.kind === 'kitvm3_vm') {
      return currentEntry.name === entry.name;
    }
    if (currentEntry.kind === 'inmotion_cpanel' && entry.kind === 'inmotion_cpanel') {
      return currentEntry.server === entry.server && currentEntry.account === entry.account;
    }
    if (currentEntry.kind === 'ec2_instance' && entry.kind === 'ec2_instance') {
      return currentEntry.instance_id === entry.instance_id;
    }
    return false;
  };

  // ---------- filtered lists --------------------------------------------

  const filteredDroplets = useMemo(() => {
    if (!droplets) return [];
    const q = search.trim().toLowerCase();
    if (!q) return droplets;
    return droplets.filter((d) =>
      [d.name, d.region, d.size, d.ip, ...(d.tags || [])]
        .filter(Boolean).join(' ').toLowerCase().includes(q),
    );
  }, [droplets, search]);

  const filteredVms = useMemo(() => {
    if (!vms) return [];
    const q = search.trim().toLowerCase();
    if (!q) return vms;
    return vms.filter((v) => v.name.toLowerCase().includes(q));
  }, [vms, search]);

  const filteredWhmAccounts = useMemo(() => {
    if (!whmAccounts) return [];
    const q = search.trim().toLowerCase();
    if (!q) return whmAccounts;
    return whmAccounts.filter((a) =>
      [a.user, a.domain, a.ip, a.owner, a.plan].filter(Boolean).join(' ').toLowerCase().includes(q),
    );
  }, [whmAccounts, search]);

  const filteredEc2 = useMemo(() => {
    if (!ec2Instances) return [];
    const q = search.trim().toLowerCase();
    if (!q) return ec2Instances;
    return ec2Instances.filter((i) =>
      [i.instance_id, i.name, i.public_ip, i.private_ip, i.instance_type, i.state]
        .filter(Boolean).join(' ').toLowerCase().includes(q),
    );
  }, [ec2Instances, search]);

  // ---------- handlers per kind -----------------------------------------

  const handlePickDroplet = (d: DropletSummary) => persist({
    kind: 'do_droplet', id: d.id, name: d.name, region: d.region, ip: d.ip,
  });

  const handlePickVm = (v: Kitvm3VmSummary) => persist({
    kind: 'kitvm3_vm', name: v.name, state: v.state,
  });

  const handlePickWhmAccount = (a: InmotionAccountSummary) => {
    if (!whmSelectedServer) return;
    persist({
      kind: 'inmotion_cpanel',
      server: whmSelectedServer,
      account: a.user,
      domain: a.domain || null,
      ip: a.ip || null,
      home_path: `/home/${a.user}`,
    });
  };

  const handleSaveEc2 = () => {
    if (!ec2SelectedInstance || !ec2Region) return;
    const inst = ec2SelectedInstance;
    if (!inst.public_ip) {
      setError('Selected instance has no public IP — connect via private IP requires extra config not yet supported by the picker.');
      return;
    }
    if (!ec2SshUser.trim() || !ec2SshKeyPath.trim()) {
      setError('SSH user and SSH key path are required.');
      return;
    }
    persist({
      kind: 'ec2_instance',
      instance_id: inst.instance_id,
      region: ec2Region,
      public_ip: inst.public_ip,
      ssh_user: ec2SshUser.trim(),
      ssh_key_path: ec2SshKeyPath.trim(),
      code_path: ec2CodePath.trim() || null,
    });
  };

  // ---------- render -----------------------------------------------------

  const showSearch = activeKind !== 'inmotion_cpanel' || !!whmSelectedServer;
  const searchPlaceholder = (() => {
    switch (activeKind) {
      case 'do_droplet': return 'Search droplets by name, region, IP, tag…';
      case 'kitvm3_vm': return 'Search VMs by name…';
      case 'inmotion_cpanel': return 'Search accounts by user, domain, IP, owner…';
      case 'ec2_instance': return 'Search instances by name, instance-id, IP, type…';
    }
  })();

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 p-4 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${isProduction ? 'bg-[#0541AD]' : 'bg-[#2660C9]'}`}>
              {isProduction ? <Cloud className="h-4 w-4 text-white" /> : <Server className="h-4 w-4 text-white" />}
            </div>
            <div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{SLOT_TITLES[slot]}</h3>
              <p className="text-xs text-gray-500 dark:text-gray-400">{TAB_META[activeKind].subtitle}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            disabled={saving}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-gray-200 px-3 pt-2 dark:border-gray-700">
          {KIND_ORDER.map((kind) => {
            const active = kind === activeKind;
            return (
              <button
                key={kind}
                type="button"
                onClick={() => setActiveKind(kind)}
                disabled={saving}
                className={`-mb-px rounded-t-md border-b-2 px-3 py-1.5 text-xs font-medium transition-colors ${
                  active
                    ? 'border-blue-500 text-blue-600 dark:text-blue-300'
                    : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                } ${saving ? 'cursor-not-allowed opacity-50' : ''}`}
              >
                {TAB_META[kind].label}
              </button>
            );
          })}
        </div>

        {/* Per-tab toolbar (server picker for WHM, region for EC2, search) */}
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 p-3 dark:border-gray-700">
          {activeKind === 'inmotion_cpanel' && (
            <select
              value={whmSelectedServer ?? ''}
              onChange={(e) => { setWhmSelectedServer(e.target.value || null); setWhmAccounts(null); }}
              disabled={!whmServers || saving}
              className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            >
              <option value="">— pick server —</option>
              {(whmServers || []).map((s) => (
                <option key={s.slug} value={s.slug}>
                  {s.slug}{s.host ? ` · ${s.host}` : ''}
                </option>
              ))}
            </select>
          )}

          {activeKind === 'ec2_instance' && (
            <Input
              type="text"
              value={ec2Region ?? ''}
              onChange={(e) => setEc2Region(e.target.value || null)}
              onBlur={() => loadList(false)}
              placeholder={ec2DefaultRegion ? `region (default: ${ec2DefaultRegion})` : 'region'}
              className="w-44"
              disabled={saving}
            />
          )}

          {showSearch && (
            <Input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className="flex-1"
              disabled={loading || saving}
            />
          )}

          <Button
            variant="outline"
            onClick={() => loadList(true)}
            disabled={refreshing || loading}
            title="Force re-fetch (skip 5-min cache)"
            className="px-2"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center gap-2 p-8 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              {activeKind === 'kitvm3_vm'
                ? 'Loading VMs (first call may take 30-40s on cold tunnel)…'
                : 'Loading…'}
            </div>
          )}

          {!loading && error && (
            <div className="m-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
              {error}
            </div>
          )}

          {!loading && !error && activeKind === 'do_droplet' && (
            <ul className="divide-y divide-gray-100 dark:divide-gray-700">
              {filteredDroplets.length === 0 && (
                <li className="p-4 text-center text-sm text-gray-500">No droplets match.</li>
              )}
              {filteredDroplets.map((d) => {
                const entry = { kind: 'do_droplet' as const, id: d.id, name: d.name, region: d.region, ip: d.ip };
                const selected = isCurrent(entry);
                return (
                  <li key={d.id}>
                    <button
                      type="button"
                      onClick={() => handlePickDroplet(d)}
                      disabled={saving}
                      className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-700/40 ${selected ? 'bg-blue-50 dark:bg-blue-900/20' : ''} ${saving ? 'cursor-not-allowed opacity-50' : ''}`}
                    >
                      <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
                        {selected ? <Check className="h-4 w-4 text-blue-500" /> : <Cloud className="h-3.5 w-3.5 text-gray-400" />}
                      </div>
                      <div className="flex-1 truncate">
                        <div className="font-medium text-gray-900 dark:text-white">{d.name}</div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {d.region || '?'} · {d.size || '?'} · {d.ip || 'no public IP'} · {d.status}
                          {d.tags?.length ? ` · ${d.tags.join(', ')}` : ''}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {!loading && !error && activeKind === 'kitvm3_vm' && (
            <ul className="divide-y divide-gray-100 dark:divide-gray-700">
              {filteredVms.length === 0 && (
                <li className="p-4 text-center text-sm text-gray-500">No VMs match.</li>
              )}
              {filteredVms.map((v) => {
                const entry = { kind: 'kitvm3_vm' as const, name: v.name, state: v.state };
                const selected = isCurrent(entry);
                const memGb = v.memory_bytes ? Math.round((v.memory_bytes / 1e9) * 10) / 10 : null;
                return (
                  <li key={v.name}>
                    <button
                      type="button"
                      onClick={() => handlePickVm(v)}
                      disabled={saving}
                      className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-700/40 ${selected ? 'bg-blue-50 dark:bg-blue-900/20' : ''} ${saving ? 'cursor-not-allowed opacity-50' : ''}`}
                    >
                      <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
                        {selected ? <Check className="h-4 w-4 text-blue-500" /> : <Server className="h-3.5 w-3.5 text-gray-400" />}
                      </div>
                      <div className="flex-1 truncate">
                        <div className="font-medium text-gray-900 dark:text-white">{v.name}</div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          state={v.state ?? '?'} · vCPU={v.vcpus ?? '?'} · {memGb != null ? `${memGb}GB` : '?'}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {!loading && !error && activeKind === 'inmotion_cpanel' && !whmSelectedServer && (
            <div className="p-6 text-center text-sm text-gray-500">
              {whmServers && whmServers.length === 0
                ? 'No WHM servers found in Vaultwarden. Add a `whm-server-<slug>` Login item per the handoff doc.'
                : 'Pick a WHM server above to load its cPanel accounts.'}
            </div>
          )}

          {!loading && !error && activeKind === 'inmotion_cpanel' && whmSelectedServer && (
            <ul className="divide-y divide-gray-100 dark:divide-gray-700">
              {filteredWhmAccounts.length === 0 && (
                <li className="p-4 text-center text-sm text-gray-500">No accounts match.</li>
              )}
              {filteredWhmAccounts.map((a) => {
                const entry = {
                  kind: 'inmotion_cpanel' as const,
                  server: whmSelectedServer,
                  account: a.user,
                  domain: a.domain || null,
                  ip: a.ip || null,
                  home_path: `/home/${a.user}`,
                };
                const selected = isCurrent(entry);
                return (
                  <li key={a.user}>
                    <button
                      type="button"
                      onClick={() => handlePickWhmAccount(a)}
                      disabled={saving}
                      className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-700/40 ${selected ? 'bg-blue-50 dark:bg-blue-900/20' : ''} ${a.suspended ? 'opacity-60' : ''} ${saving ? 'cursor-not-allowed opacity-50' : ''}`}
                    >
                      <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
                        {selected ? <Check className="h-4 w-4 text-blue-500" /> : <Server className="h-3.5 w-3.5 text-gray-400" />}
                      </div>
                      <div className="flex-1 truncate">
                        <div className="font-medium text-gray-900 dark:text-white">
                          {a.user}{a.suspended ? ' · SUSPENDED' : ''}
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {a.domain || '?'} · {a.ip || '?'} · owner={a.owner || '?'} · {a.plan || '?'}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {!loading && !error && activeKind === 'ec2_instance' && (
            <>
              <ul className="divide-y divide-gray-100 dark:divide-gray-700">
                {filteredEc2.length === 0 && (
                  <li className="p-4 text-center text-sm text-gray-500">
                    No instances match{ec2Region ? ` in ${ec2Region}` : ''}.
                  </li>
                )}
                {filteredEc2.map((i) => {
                  const selected = ec2SelectedInstance?.instance_id === i.instance_id
                    || (isCurrent({ kind: 'ec2_instance', instance_id: i.instance_id, region: ec2Region ?? '', public_ip: i.public_ip ?? '', ssh_user: '', ssh_key_path: '' }));
                  return (
                    <li key={i.instance_id}>
                      <button
                        type="button"
                        onClick={() => setEc2SelectedInstance(i)}
                        disabled={saving}
                        className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-700/40 ${selected ? 'bg-blue-50 dark:bg-blue-900/20' : ''} ${saving ? 'cursor-not-allowed opacity-50' : ''}`}
                      >
                        <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
                          {selected ? <Check className="h-4 w-4 text-blue-500" /> : <Cloud className="h-3.5 w-3.5 text-gray-400" />}
                        </div>
                        <div className="flex-1 truncate">
                          <div className="font-medium text-gray-900 dark:text-white">
                            {i.name || i.instance_id} <span className="text-xs text-gray-500 dark:text-gray-400">· {i.instance_id}</span>
                          </div>
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            {i.state} · {i.instance_type} · {i.public_ip || 'no public IP'}
                            {i.key_name ? ` · key=${i.key_name}` : ''}
                            {i.availability_zone ? ` · ${i.availability_zone}` : ''}
                          </div>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>

              {ec2SelectedInstance && (
                <div className="border-t border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/30">
                  <div className="mb-3 text-xs font-medium text-gray-700 dark:text-gray-300">
                    Connection details — needed because the SSH key lives in the project, not in vault.
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <label className="flex flex-col text-xs">
                      <span className="mb-0.5 text-gray-500 dark:text-gray-400">SSH user</span>
                      <Input
                        type="text"
                        value={ec2SshUser}
                        onChange={(e) => setEc2SshUser(e.target.value)}
                        placeholder="ubuntu"
                        disabled={saving}
                      />
                    </label>
                    <label className="flex flex-col text-xs">
                      <span className="mb-0.5 text-gray-500 dark:text-gray-400">SSH key path (relative to project root)</span>
                      <Input
                        type="text"
                        value={ec2SshKeyPath}
                        onChange={(e) => setEc2SshKeyPath(e.target.value)}
                        placeholder={`./${ec2SelectedInstance.key_name || 'aws-key'}.pem`}
                        disabled={saving}
                      />
                    </label>
                    <label className="flex flex-col text-xs sm:col-span-2">
                      <span className="mb-0.5 text-gray-500 dark:text-gray-400">Code path on instance (optional)</span>
                      <Input
                        type="text"
                        value={ec2CodePath}
                        onChange={(e) => setEc2CodePath(e.target.value)}
                        placeholder="/home/ubuntu/myapp"
                        disabled={saving}
                      />
                    </label>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-gray-200 p-3 dark:border-gray-700">
          <Button
            variant="outline"
            onClick={() => persist(null)}
            disabled={saving || !currentEntry}
            className="text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
            title="Clear the assignment for this slot"
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            Clear
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            {activeKind === 'ec2_instance' && (
              <Button onClick={handleSaveEc2} disabled={saving || !ec2SelectedInstance}>
                {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1 h-3.5 w-3.5" />}
                Save
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
