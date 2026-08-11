import { useState } from 'react';
import { Cloud, Server, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../shared/view/ui';
import EnvironmentPickerModal from '../../lab-environments/EnvironmentPickerModal';
import type { EnvironmentEntry, EnvironmentSlot } from '../../lab-environments/types';

type StepEnvironmentsProps = {
  prodEnvironment: EnvironmentEntry;
  devEnvironment: EnvironmentEntry;
  isCreating: boolean;
  onProdChange: (entry: EnvironmentEntry) => void;
  onDevChange: (entry: EnvironmentEntry) => void;
};

function formatEntry(entry: EnvironmentEntry): string {
  if (!entry) return 'Not set';
  switch (entry.kind) {
    case 'do_droplet':
      return `DO droplet · ${entry.name || `id ${entry.id}`}${entry.ip ? ` (${entry.ip})` : ''}`;
    case 'kitvm3_vm':
      return `Hyper-V VM · ${entry.name}`;
    case 'inmotion_cpanel':
      return `WHM/cPanel · ${entry.server}:${entry.account}${entry.domain ? ` (${entry.domain})` : ''}`;
    case 'ec2_instance':
      return `EC2 · ${entry.instance_id}${entry.public_ip ? ` (${entry.public_ip})` : ''}`;
    default:
      return 'Unknown';
  }
}

export default function StepEnvironments({
  prodEnvironment,
  devEnvironment,
  isCreating,
  onProdChange,
  onDevChange,
}: StepEnvironmentsProps) {
  const { t } = useTranslation();
  const [pickerSlot, setPickerSlot] = useState<EnvironmentSlot | null>(null);

  const onPick = (entry: EnvironmentEntry) => {
    if (pickerSlot === 'production') onProdChange(entry);
    else if (pickerSlot === 'development') onDevChange(entry);
  };

  const renderSlot = (
    slot: EnvironmentSlot,
    label: string,
    entry: EnvironmentEntry,
    onClear: () => void,
    icon: typeof Cloud,
    accent: string,
  ) => {
    const Icon = icon;
    const isSet = !!entry;
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900/40">
        <div className="mb-3 flex items-center gap-3">
          <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${accent}`}>
            <Icon className="h-4 w-4 text-white" />
          </div>
          <div className="flex-1">
            <h4 className="text-sm font-semibold text-gray-900 dark:text-white">{label}</h4>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {isSet ? formatEntry(entry) : 'Not set — pick later via the header pills or skip.'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setPickerSlot(slot)}
            disabled={isCreating}
          >
            {isSet ? 'Change' : 'Set'}
          </Button>
          {isSet && (
            <Button
              variant="outline"
              onClick={onClear}
              disabled={isCreating}
              className="text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
            >
              <Trash2 className="mr-1 h-3.5 w-3.5" />
              Clear
            </Button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="mb-1 text-lg font-medium text-gray-900 dark:text-white">
          {t('projectWizard.stepEnvironments.title', { defaultValue: 'Project environments' })}
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t('projectWizard.stepEnvironments.help', {
            defaultValue:
              'Optionally pick the production and development targets this project will deploy to. Both are optional — you can set or change these any time from the project header. Picks are written to .lab/environments.json and become part of the project context the chat sees.',
          })}
        </p>
      </div>

      {renderSlot(
        'production',
        'Production',
        prodEnvironment,
        () => onProdChange(null),
        Cloud,
        'bg-[#0541AD]',
      )}

      {renderSlot(
        'development',
        'Development',
        devEnvironment,
        () => onDevChange(null),
        Server,
        'bg-[#2660C9]',
      )}

      {pickerSlot && (
        <EnvironmentPickerModal
          slot={pickerSlot}
          currentEntry={pickerSlot === 'production' ? prodEnvironment : devEnvironment}
          onClose={() => setPickerSlot(null)}
          onPick={onPick}
        />
      )}
    </div>
  );
}
