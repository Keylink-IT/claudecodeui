import { useCallback, useEffect, useMemo, useState } from 'react';
import { FolderPlus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { EnvironmentEntry } from '../lab-environments/types';
import ErrorBanner from './components/ErrorBanner';
import StepConfiguration from './components/StepConfiguration';
import StepConsoleProject from './components/StepConsoleProject';
import StepEnvironments from './components/StepEnvironments';
import StepGitRemote from './components/StepGitRemote';
import StepReview from './components/StepReview';
import StepTypeSelection from './components/StepTypeSelection';
import WizardFooter from './components/WizardFooter';
import WizardProgress from './components/WizardProgress';
import { useGithubTokens } from './hooks/useGithubTokens';
import {
  cloneWorkspaceWithProgress,
  createWithGitProgress,
  searchGiteaRepos,
} from './data/workspaceApi';
import type {
  ConsoleProjectSelection,
  GitRemoteMode,
  GiteaRepoSummary,
  TokenMode,
  WizardFormState,
  WizardStep,
  WorkspaceType,
} from './types';

type ProjectCreationWizardProps = {
  onClose: () => void;
  onProjectCreated?: (project?: Record<string, unknown>, workspaceType?: WorkspaceType) => void;
};

const DEFAULT_GITEA_ORG = 'keylink-studio';

const initialFormState: WizardFormState = {
  workspaceType: 'existing',
  workspacePath: '',
  prdProjectName: '',
  gitRemoteMode: 'none',
  gitCreateName: '',
  gitCreateOrg: DEFAULT_GITEA_ORG,
  gitCreatePrivate: false,
  gitPickedRepo: null,
  githubUrl: '',
  tokenMode: 'stored',
  selectedGithubToken: '',
  newGithubToken: '',
  consoleProject: null,
  prodEnvironment: null,
  devEnvironment: null,
};

export default function ProjectCreationWizard({
  onClose,
  onProjectCreated,
}: ProjectCreationWizardProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<WizardStep>(1);
  const [formState, setFormState] = useState<WizardFormState>(initialFormState);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progressMessage, setProgressMessage] = useState('');
  const [defaultGiteaOrg, setDefaultGiteaOrg] = useState(DEFAULT_GITEA_ORG);

  // Auto-default git remote mode based on workspace type when entering step 3.
  useEffect(() => {
    if (step !== 3) return;
    setFormState((previous) => {
      if (previous.gitRemoteMode !== 'none' || previous.workspaceType === 'existing') {
        return previous;
      }
      return {
        ...previous,
        gitRemoteMode: 'create',
        gitCreateName:
          previous.gitCreateName ||
          (previous.workspaceType === 'from-prd'
            ? slugifyName(previous.prdProjectName)
            : pickLeafName(previous.workspacePath)),
      };
    });
  }, [step]);

  // Lazy-load default org from the search endpoint the first time step 3 opens.
  useEffect(() => {
    if (step !== 3) return;
    let disposed = false;
    searchGiteaRepos('')
      .then((data) => {
        if (!disposed && data.defaultOrg) {
          setDefaultGiteaOrg(data.defaultOrg);
          setFormState((prev) =>
            prev.gitCreateOrg === DEFAULT_GITEA_ORG
              ? { ...prev, gitCreateOrg: data.defaultOrg }
              : prev,
          );
        }
      })
      .catch(() => {
        // Non-fatal — search can fail later when the user actually picks. Step 3 still works.
      });
    return () => {
      disposed = true;
    };
  }, [step]);

  const shouldLoadGithubTokens =
    step === 3 &&
    formState.gitRemoteMode === 'external' &&
    formState.githubUrl.trim().length > 0 &&
    !formState.githubUrl.trim().startsWith('git@') &&
    !formState.githubUrl.trim().startsWith('ssh://');

  const autoSelectToken = useCallback((tokenId: string) => {
    setFormState((previous) => ({ ...previous, selectedGithubToken: tokenId }));
  }, []);

  const {
    tokens: availableTokens,
    loading: loadingTokens,
    loadError: tokenLoadError,
    selectedTokenName,
  } = useGithubTokens({
    shouldLoad: shouldLoadGithubTokens,
    selectedTokenId: formState.selectedGithubToken,
    onAutoSelectToken: autoSelectToken,
  });

  const updateField = useCallback(
    <K extends keyof WizardFormState>(key: K, value: WizardFormState[K]) => {
      setFormState((previous) => ({ ...previous, [key]: value }));
    },
    [],
  );

  const updateWorkspaceType = useCallback(
    (workspaceType: WorkspaceType) => updateField('workspaceType', workspaceType),
    [updateField],
  );

  const updateTokenMode = useCallback(
    (tokenMode: TokenMode) => updateField('tokenMode', tokenMode),
    [updateField],
  );

  const updateGitRemoteMode = useCallback(
    (gitRemoteMode: GitRemoteMode) => updateField('gitRemoteMode', gitRemoteMode),
    [updateField],
  );

  const updatePickedRepo = useCallback(
    (gitPickedRepo: GiteaRepoSummary | null) => updateField('gitPickedRepo', gitPickedRepo),
    [updateField],
  );

  const handleNext = useCallback(() => {
    setError(null);

    if (step === 1) {
      if (!formState.workspaceType) {
        setError(t('projectWizard.errors.selectType'));
        return;
      }
      setStep(2);
      return;
    }

    if (step === 2) {
      if (formState.workspaceType === 'from-prd') {
        if (!formState.prdProjectName.trim()) {
          setError(t('projectWizard.errors.providePrdName'));
          return;
        }
      } else if (!formState.workspacePath.trim()) {
        setError(t('projectWizard.errors.providePath'));
        return;
      }
      setStep(3);
      return;
    }

    if (step === 3) {
      const validation = validateGitRemoteStep(formState, t);
      if (validation) {
        setError(validation);
        return;
      }
      // From-PRD projects get Console linkage (step 4) and Environments (step 5)
      // before review. Other workspace types skip directly to review (step 6).
      setStep(formState.workspaceType === 'from-prd' ? 4 : 6);
      return;
    }

    if (step === 4) {
      // Console step is optional — null selection means "skip", which is fine.
      setStep(5);
      return;
    }

    if (step === 5) {
      // Environments step is optional — both slots may be null.
      setStep(6);
    }
  }, [formState, step, t]);

  const handleBack = useCallback(() => {
    setError(null);
    setStep((previousStep) => {
      // From step 6 (Review) back: PRD goes to Environments (5), others to Git (3).
      if (previousStep === 6 && formState.workspaceType !== 'from-prd') return 3;
      return previousStep > 1 ? ((previousStep - 1) as WizardStep) : previousStep;
    });
  }, [formState.workspaceType]);

  const handleCreate = useCallback(async () => {
    setIsCreating(true);
    setError(null);
    setProgressMessage('');

    try {
      const useExternalClone =
        formState.gitRemoteMode === 'external' &&
        formState.githubUrl.trim() !== '' &&
        (formState.workspaceType === 'new' || formState.workspaceType === 'from-prd');

      if (useExternalClone) {
        const project = await cloneWorkspaceWithProgress(
          {
            workspacePath: formState.workspacePath,
            githubUrl: formState.githubUrl,
            tokenMode: formState.tokenMode,
            selectedGithubToken: formState.selectedGithubToken,
            newGithubToken: formState.newGithubToken,
          },
          { onProgress: setProgressMessage },
        );

        onProjectCreated?.(project, formState.workspaceType);
        onClose();
        return;
      }

      const result = await createWithGitProgress(
        {
          workspaceType: formState.workspaceType,
          workspacePath: formState.workspacePath,
          prdProjectName: formState.prdProjectName,
          gitRemoteMode: formState.gitRemoteMode === 'external' ? 'none' : formState.gitRemoteMode,
          gitCreateName: formState.gitCreateName,
          gitCreateOrg: formState.gitCreateOrg,
          gitCreatePrivate: formState.gitCreatePrivate,
          gitPickedRepo: formState.gitPickedRepo,
          consoleProject: formState.consoleProject,
          prodEnvironment: formState.prodEnvironment,
          devEnvironment: formState.devEnvironment,
        },
        { onProgress: setProgressMessage },
      );

      onProjectCreated?.(result.project, result.workspaceType ?? formState.workspaceType);
      onClose();
    } catch (createError) {
      const errorMessage =
        createError instanceof Error
          ? createError.message
          : t('projectWizard.errors.failedToCreate');
      setError(errorMessage);
    } finally {
      setIsCreating(false);
    }
  }, [formState, onClose, onProjectCreated, t]);

  const isCloneWorkflow = useMemo(
    () =>
      formState.gitRemoteMode === 'external' &&
      formState.githubUrl.trim() !== '' &&
      (formState.workspaceType === 'new' || formState.workspaceType === 'from-prd'),
    [formState.githubUrl, formState.gitRemoteMode, formState.workspaceType],
  );

  return (
    <div className="fixed bottom-0 left-0 right-0 top-0 z-[60] flex items-center justify-center bg-black/50 p-0 backdrop-blur-sm sm:p-4">
      <div className="h-full w-full overflow-y-auto rounded-none border-0 border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800 sm:h-auto sm:max-w-2xl sm:rounded-lg sm:border">
        <div className="flex items-center justify-between border-b border-gray-200 p-6 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/50">
              <FolderPlus className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            </div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              {t('projectWizard.title')}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            disabled={isCreating}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <WizardProgress step={step} workspaceType={formState.workspaceType} />

        <div className="min-h-[300px] space-y-6 p-6">
          {error && <ErrorBanner message={error} />}

          {step === 1 && (
            <StepTypeSelection
              workspaceType={formState.workspaceType}
              onWorkspaceTypeChange={updateWorkspaceType}
            />
          )}

          {step === 2 && (
            <StepConfiguration
              workspaceType={formState.workspaceType}
              workspacePath={formState.workspacePath}
              prdProjectName={formState.prdProjectName}
              isCreating={isCreating}
              onWorkspacePathChange={(workspacePath) => updateField('workspacePath', workspacePath)}
              onPrdProjectNameChange={(name) => updateField('prdProjectName', name)}
              onAdvanceToConfirm={() => setStep(4)}
            />
          )}

          {step === 3 && (
            <StepGitRemote
              gitRemoteMode={formState.gitRemoteMode}
              gitCreateName={formState.gitCreateName}
              gitCreateOrg={formState.gitCreateOrg}
              gitCreatePrivate={formState.gitCreatePrivate}
              gitPickedRepo={formState.gitPickedRepo}
              defaultOrg={defaultGiteaOrg}
              githubUrl={formState.githubUrl}
              tokenMode={formState.tokenMode}
              selectedGithubToken={formState.selectedGithubToken}
              newGithubToken={formState.newGithubToken}
              availableTokens={availableTokens}
              loadingTokens={loadingTokens}
              tokenLoadError={tokenLoadError}
              isCreating={isCreating}
              showExternalMode={
                formState.workspaceType === 'new' || formState.workspaceType === 'from-prd'
              }
              onGitRemoteModeChange={updateGitRemoteMode}
              onGitCreateNameChange={(name) => updateField('gitCreateName', name)}
              onGitCreateOrgChange={(org) => updateField('gitCreateOrg', org)}
              onGitCreatePrivateChange={(value) => updateField('gitCreatePrivate', value)}
              onGitPickedRepoChange={updatePickedRepo}
              onGithubUrlChange={(githubUrl) => updateField('githubUrl', githubUrl)}
              onTokenModeChange={updateTokenMode}
              onSelectedGithubTokenChange={(id) => updateField('selectedGithubToken', id)}
              onNewGithubTokenChange={(token) => updateField('newGithubToken', token)}
            />
          )}

          {step === 4 && formState.workspaceType === 'from-prd' && (
            <StepConsoleProject
              selection={formState.consoleProject}
              isCreating={isCreating}
              onSelectionChange={(selection: ConsoleProjectSelection | null) =>
                updateField('consoleProject', selection)
              }
            />
          )}

          {step === 5 && formState.workspaceType === 'from-prd' && (
            <StepEnvironments
              prodEnvironment={formState.prodEnvironment}
              devEnvironment={formState.devEnvironment}
              isCreating={isCreating}
              onProdChange={(entry: EnvironmentEntry) => updateField('prodEnvironment', entry)}
              onDevChange={(entry: EnvironmentEntry) => updateField('devEnvironment', entry)}
            />
          )}

          {step === 6 && (
            <StepReview
              formState={formState}
              selectedTokenName={selectedTokenName}
              isCreating={isCreating}
              cloneProgress={isCloneWorkflow ? progressMessage : ''}
              remoteProgress={!isCloneWorkflow ? progressMessage : ''}
            />
          )}
        </div>

        <WizardFooter
          step={step}
          isCreating={isCreating}
          isCloneWorkflow={isCloneWorkflow}
          onClose={onClose}
          onBack={handleBack}
          onNext={handleNext}
          onCreate={handleCreate}
        />
      </div>
    </div>
  );
}

function validateGitRemoteStep(state: WizardFormState, t: (key: string) => string): string | null {
  switch (state.gitRemoteMode) {
    case 'create':
      if (!state.gitCreateName.trim()) return t('projectWizard.errors.provideRepoName');
      if (!/^[A-Za-z0-9_.-]+$/.test(state.gitCreateName.trim())) {
        return t('projectWizard.errors.invalidRepoName');
      }
      return null;
    case 'pick':
      if (!state.gitPickedRepo) return t('projectWizard.errors.pickRepo');
      return null;
    case 'external':
      if (!state.githubUrl.trim()) return t('projectWizard.errors.provideGithubUrl');
      return null;
    case 'none':
    default:
      return null;
  }
}

function pickLeafName(workspacePath: string): string {
  const trimmed = workspacePath.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return '';
  const segments = trimmed.split(/[\\/]/);
  return slugifyName(segments[segments.length - 1] || '');
}

function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
