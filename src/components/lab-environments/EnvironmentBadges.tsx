import { useCallback, useEffect, useState } from 'react';
import { Cloud, Server } from 'lucide-react';
import { fetchProjectEnvironments } from './data/labApi';
import type { EnvironmentEntry, EnvironmentSlot, ProjectEnvironments } from './types';
import EnvironmentPickerModal from './EnvironmentPickerModal';

type EnvironmentBadgesProps = {
  projectName: string | null;
};

function formatEntry(entry: EnvironmentEntry): string {
  if (!entry) return 'not set';
  if (entry.kind === 'do_droplet') return entry.name || `droplet ${entry.id ?? '?'}`;
  if (entry.kind === 'kitvm3_vm') return entry.name;
  if (entry.kind === 'inmotion_cpanel') return `${entry.server}:${entry.account}`;
  if (entry.kind === 'ec2_instance') return entry.public_ip || entry.instance_id;
  return 'unknown';
}

export default function EnvironmentBadges({ projectName }: EnvironmentBadgesProps) {
  const [envs, setEnvs] = useState<ProjectEnvironments | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerSlot, setPickerSlot] = useState<EnvironmentSlot | null>(null);

  const loadEnvs = useCallback(async (name: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchProjectEnvironments(name);
      setEnvs(result.environments);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load failed');
      setEnvs(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!projectName) {
      setEnvs(null);
      return;
    }
    void loadEnvs(projectName);
  }, [projectName, loadEnvs]);

  if (!projectName) return null;

  const handleSaved = (updated: ProjectEnvironments) => {
    setEnvs(updated);
  };

  const renderPill = (slot: EnvironmentSlot, label: string, icon: typeof Cloud, color: string) => {
    const entry = envs?.[slot] ?? null;
    const value = loading ? '…' : error ? 'error' : formatEntry(entry);
    const isSet = !!entry;
    const Icon = icon;
    return (
      <button
        type="button"
        onClick={() => setPickerSlot(slot)}
        className={`group inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
          isSet
            ? `border-transparent ${color} text-white hover:opacity-90`
            : 'border-dashed border-muted-foreground/40 bg-muted/30 text-muted-foreground hover:border-muted-foreground hover:text-foreground'
        }`}
        title={error ? error : `Click to ${isSet ? 'change' : 'assign'} the ${slot} environment`}
      >
        <Icon className="h-3 w-3 flex-shrink-0" aria-hidden />
        <span className="font-semibold uppercase tracking-wide opacity-80">{label}</span>
        <span className="truncate max-w-[12ch]">{value}</span>
      </button>
    );
  };

  return (
    <>
      <div className="hidden items-center gap-1.5 lg:flex">
        {renderPill('production', 'Prod', Cloud, 'bg-[#0541AD]')}
        {renderPill('development', 'Dev', Server, 'bg-[#2660C9]')}
      </div>

      {pickerSlot && (
        <EnvironmentPickerModal
          projectName={projectName}
          slot={pickerSlot}
          currentEntry={envs?.[pickerSlot] ?? null}
          onClose={() => setPickerSlot(null)}
          onSaved={(updated) => {
            handleSaved(updated);
            setPickerSlot(null);
          }}
        />
      )}
    </>
  );
}
