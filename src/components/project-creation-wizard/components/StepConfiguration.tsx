import { useTranslation } from 'react-i18next';
import { Input } from '../../../shared/view/ui';
import type { WorkspaceType } from '../types';
import WorkspacePathField from './WorkspacePathField';

type StepConfigurationProps = {
  workspaceType: WorkspaceType;
  workspacePath: string;
  prdProjectName: string;
  isCreating: boolean;
  onWorkspacePathChange: (workspacePath: string) => void;
  onPrdProjectNameChange: (name: string) => void;
  onAdvanceToConfirm: () => void;
};

export default function StepConfiguration({
  workspaceType,
  workspacePath,
  prdProjectName,
  isCreating,
  onWorkspacePathChange,
  onPrdProjectNameChange,
  onAdvanceToConfirm,
}: StepConfigurationProps) {
  const { t } = useTranslation();

  if (workspaceType === 'from-prd') {
    return (
      <div className="space-y-4">
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('projectWizard.step2.prdName')}
          </label>
          <Input
            type="text"
            value={prdProjectName}
            onChange={(event) => onPrdProjectNameChange(event.target.value)}
            placeholder={t('projectWizard.step2.prdNamePlaceholder', {
              defaultValue: 'my-new-product',
            })}
            className="w-full"
            disabled={isCreating}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('projectWizard.step2.prdNameHelp')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {workspaceType === 'existing'
            ? t('projectWizard.step2.existingPath')
            : t('projectWizard.step2.newPath')}
        </label>

        <WorkspacePathField
          value={workspacePath}
          disabled={isCreating}
          onChange={onWorkspacePathChange}
          onAdvanceToConfirm={onAdvanceToConfirm}
        />

        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {workspaceType === 'existing'
            ? t('projectWizard.step2.existingHelp')
            : t('projectWizard.step2.newHelp')}
        </p>
      </div>
    </div>
  );
}
