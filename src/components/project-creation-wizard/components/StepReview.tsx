import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { isSshGitUrl } from '../utils/pathUtils';
import type { WizardFormState } from '../types';
import type { EnvironmentEntry } from '../../lab-environments/types';

function formatEnvEntry(entry: EnvironmentEntry): string {
  if (!entry) return 'Not set';
  switch (entry.kind) {
    case 'do_droplet':
      return `DO droplet · ${entry.name || `id ${entry.id}`}`;
    case 'kitvm3_vm':
      return `Hyper-V VM · ${entry.name}`;
    case 'inmotion_cpanel':
      return `cPanel · ${entry.server}:${entry.account}`;
    case 'ec2_instance':
      return `EC2 · ${entry.instance_id}`;
    default:
      return 'Unknown';
  }
}

type StepReviewProps = {
  formState: WizardFormState;
  selectedTokenName: string | null;
  isCreating: boolean;
  cloneProgress: string;
  remoteProgress: string;
};

export default function StepReview({
  formState,
  selectedTokenName,
  isCreating,
  cloneProgress,
  remoteProgress,
}: StepReviewProps) {
  const { t } = useTranslation();

  const authenticationLabel = useMemo(() => {
    if (formState.tokenMode === 'stored' && formState.selectedGithubToken) {
      return `${t('projectWizard.step4.usingStoredToken')} ${selectedTokenName || 'Unknown'}`;
    }

    if (formState.tokenMode === 'new' && formState.newGithubToken.trim()) {
      return t('projectWizard.step4.usingProvidedToken');
    }

    if (isSshGitUrl(formState.githubUrl)) {
      return t('projectWizard.step4.sshKey', { defaultValue: 'SSH Key' });
    }

    return t('projectWizard.step4.noAuthentication');
  }, [formState, selectedTokenName, t]);

  const workspaceTypeLabel = useMemo(() => {
    if (formState.workspaceType === 'existing') return t('projectWizard.step4.existingWorkspace');
    if (formState.workspaceType === 'from-prd') return t('projectWizard.step4.fromPrdWorkspace');
    return t('projectWizard.step4.newWorkspace');
  }, [formState.workspaceType, t]);

  const gitRemoteLabel = useMemo(() => {
    switch (formState.gitRemoteMode) {
      case 'create':
        return t('projectWizard.step4.gitRemote.create', {
          full: `${formState.gitCreateOrg}/${formState.gitCreateName}`,
          defaultValue: `Create {{full}} on git.keylinkit.net`,
        });
      case 'pick':
        return t('projectWizard.step4.gitRemote.pick', {
          full: formState.gitPickedRepo?.full_name || '—',
          defaultValue: 'Use existing {{full}}',
        });
      case 'external':
        return t('projectWizard.step4.gitRemote.external', {
          url: formState.githubUrl || '—',
          defaultValue: 'Clone {{url}}',
        });
      case 'none':
      default:
        return t('projectWizard.step4.gitRemote.none', { defaultValue: 'No remote (local only)' });
    }
  }, [formState, t]);

  const showAuthRow = formState.gitRemoteMode === 'external' && formState.githubUrl.trim() !== '';
  const progressMessage = remoteProgress || cloneProgress;
  const isCloningExternal = formState.gitRemoteMode === 'external' && formState.githubUrl.trim() !== '';

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/50">
        <h4 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">
          {t('projectWizard.step4.reviewConfig')}
        </h4>

        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-gray-600 dark:text-gray-400">
              {t('projectWizard.step4.workspaceType')}
            </span>
            <span className="font-medium text-gray-900 dark:text-white">{workspaceTypeLabel}</span>
          </div>

          {formState.workspaceType === 'from-prd' ? (
            <div className="flex justify-between text-sm">
              <span className="text-gray-600 dark:text-gray-400">
                {t('projectWizard.step4.projectName', { defaultValue: 'Project name:' })}
              </span>
              <span className="break-all font-mono text-xs text-gray-900 dark:text-white">
                {formState.prdProjectName}
              </span>
            </div>
          ) : (
            <div className="flex justify-between text-sm">
              <span className="text-gray-600 dark:text-gray-400">{t('projectWizard.step4.path')}</span>
              <span className="break-all font-mono text-xs text-gray-900 dark:text-white">
                {formState.workspacePath}
              </span>
            </div>
          )}

          <div className="flex justify-between text-sm">
            <span className="text-gray-600 dark:text-gray-400">
              {t('projectWizard.step4.gitRemote.label', { defaultValue: 'Git remote:' })}
            </span>
            <span className="break-all text-right text-xs text-gray-900 dark:text-white">
              {gitRemoteLabel}
            </span>
          </div>

          {showAuthRow && (
            <div className="flex justify-between text-sm">
              <span className="text-gray-600 dark:text-gray-400">
                {t('projectWizard.step4.authentication')}
              </span>
              <span className="text-xs text-gray-900 dark:text-white">{authenticationLabel}</span>
            </div>
          )}

          {formState.workspaceType === 'from-prd' && (
            <div className="flex justify-between text-sm">
              <span className="text-gray-600 dark:text-gray-400">Console project:</span>
              <span className="text-right text-xs text-gray-900 dark:text-white">
                {formState.consoleProject
                  ? `${formState.consoleProject.name}${formState.consoleProject.isNew ? ' (new)' : ''}`
                  : 'None (skipped)'}
              </span>
            </div>
          )}

          {formState.workspaceType === 'from-prd' && (
            <>
              <div className="flex justify-between text-sm">
                <span className="text-gray-600 dark:text-gray-400">Production env:</span>
                <span className="text-right text-xs text-gray-900 dark:text-white">
                  {formatEnvEntry(formState.prodEnvironment)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-600 dark:text-gray-400">Development env:</span>
                <span className="text-right text-xs text-gray-900 dark:text-white">
                  {formatEnvEntry(formState.devEnvironment)}
                </span>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-900/20">
        {isCreating && progressMessage ? (
          <div className="space-y-2">
            <p className="text-sm font-medium text-blue-800 dark:text-blue-200">
              {isCloningExternal
                ? t('projectWizard.step4.cloningRepository', { defaultValue: 'Cloning repository...' })
                : t('projectWizard.step4.creatingProject', { defaultValue: 'Creating project...' })}
            </p>
            <code className="block whitespace-pre-wrap break-all font-mono text-xs text-blue-700 dark:text-blue-300">
              {progressMessage}
            </code>
          </div>
        ) : (
          <p className="text-sm text-blue-800 dark:text-blue-200">
            {formState.workspaceType === 'existing'
              ? t('projectWizard.step4.existingInfo')
              : formState.workspaceType === 'from-prd'
                ? t('projectWizard.step4.fromPrdInfo')
                : isCloningExternal
                  ? t('projectWizard.step4.newWithClone')
                  : t('projectWizard.step4.newEmpty')}
          </p>
        )}
      </div>
    </div>
  );
}
