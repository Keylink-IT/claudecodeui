import { useEffect, useMemo, useState } from 'react';
import { Check, GitBranch, Globe, Loader2, Plus, SearchCode, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '../../../shared/view/ui';
import { searchGiteaRepos } from '../data/workspaceApi';
import type {
  GitRemoteMode,
  GiteaRepoSummary,
  GithubTokenCredential,
  TokenMode,
} from '../types';
import GithubAuthenticationCard from './GithubAuthenticationCard';

type StepGitRemoteProps = {
  gitRemoteMode: GitRemoteMode;
  gitCreateName: string;
  gitCreateOrg: string;
  gitCreatePrivate: boolean;
  gitPickedRepo: GiteaRepoSummary | null;
  defaultOrg: string;
  // External-URL clone mode bits.
  githubUrl: string;
  tokenMode: TokenMode;
  selectedGithubToken: string;
  newGithubToken: string;
  availableTokens: GithubTokenCredential[];
  loadingTokens: boolean;
  tokenLoadError: string | null;
  isCreating: boolean;
  showExternalMode: boolean;
  onGitRemoteModeChange: (mode: GitRemoteMode) => void;
  onGitCreateNameChange: (name: string) => void;
  onGitCreateOrgChange: (org: string) => void;
  onGitCreatePrivateChange: (isPrivate: boolean) => void;
  onGitPickedRepoChange: (repo: GiteaRepoSummary | null) => void;
  onGithubUrlChange: (url: string) => void;
  onTokenModeChange: (mode: TokenMode) => void;
  onSelectedGithubTokenChange: (id: string) => void;
  onNewGithubTokenChange: (token: string) => void;
};

type ModeConfig = {
  mode: GitRemoteMode;
  icon: typeof GitBranch;
  labelKey: string;
};

const ALL_MODES: ModeConfig[] = [
  { mode: 'create', icon: Plus, labelKey: 'projectWizard.step3.modes.create' },
  { mode: 'pick', icon: SearchCode, labelKey: 'projectWizard.step3.modes.pick' },
  { mode: 'external', icon: Globe, labelKey: 'projectWizard.step3.modes.external' },
  { mode: 'none', icon: X, labelKey: 'projectWizard.step3.modes.none' },
];

export default function StepGitRemote({
  gitRemoteMode,
  gitCreateName,
  gitCreateOrg,
  gitCreatePrivate,
  gitPickedRepo,
  defaultOrg,
  githubUrl,
  tokenMode,
  selectedGithubToken,
  newGithubToken,
  availableTokens,
  loadingTokens,
  tokenLoadError,
  isCreating,
  showExternalMode,
  onGitRemoteModeChange,
  onGitCreateNameChange,
  onGitCreateOrgChange,
  onGitCreatePrivateChange,
  onGitPickedRepoChange,
  onGithubUrlChange,
  onTokenModeChange,
  onSelectedGithubTokenChange,
  onNewGithubTokenChange,
}: StepGitRemoteProps) {
  const { t } = useTranslation();
  const modes = useMemo(
    () => ALL_MODES.filter((m) => showExternalMode || m.mode !== 'external'),
    [showExternalMode],
  );

  return (
    <div className="space-y-4">
      <div>
        <h4 className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('projectWizard.step3.title')}
        </h4>
        <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
          {t('projectWizard.step3.help')}
        </p>

        <div
          className={`grid grid-cols-2 gap-2 ${modes.length === 4 ? 'md:grid-cols-4' : 'md:grid-cols-3'}`}
        >
          {modes.map(({ mode, icon: Icon, labelKey }) => {
            const selected = gitRemoteMode === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => onGitRemoteModeChange(mode)}
                disabled={isCreating}
                className={`flex items-center gap-2 rounded-lg border-2 p-3 text-left text-sm transition-all ${
                  selected
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                    : 'border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600'
                } ${isCreating ? 'cursor-not-allowed opacity-60' : ''}`}
              >
                <Icon className="h-4 w-4 flex-shrink-0 text-gray-600 dark:text-gray-400" />
                <span className="font-medium text-gray-900 dark:text-white">{t(labelKey)}</span>
              </button>
            );
          })}
        </div>
      </div>

      {gitRemoteMode === 'create' && (
        <CreateRepoFields
          name={gitCreateName}
          org={gitCreateOrg}
          isPrivate={gitCreatePrivate}
          defaultOrg={defaultOrg}
          isCreating={isCreating}
          onNameChange={onGitCreateNameChange}
          onOrgChange={onGitCreateOrgChange}
          onPrivateChange={onGitCreatePrivateChange}
        />
      )}

      {gitRemoteMode === 'pick' && (
        <PickRepoFields
          pickedRepo={gitPickedRepo}
          isCreating={isCreating}
          onPickedRepoChange={onGitPickedRepoChange}
        />
      )}

      {gitRemoteMode === 'external' && (
        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('projectWizard.step2.githubUrl')}
            </label>
            <Input
              type="text"
              value={githubUrl}
              onChange={(event) => onGithubUrlChange(event.target.value)}
              placeholder="https://github.com/username/repository"
              className="w-full"
              disabled={isCreating}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('projectWizard.step2.githubHelp')}
            </p>
          </div>

          {githubUrl.trim() && !githubUrl.trim().startsWith('git@') && !githubUrl.trim().startsWith('ssh://') && (
            <GithubAuthenticationCard
              tokenMode={tokenMode}
              selectedGithubToken={selectedGithubToken}
              newGithubToken={newGithubToken}
              availableTokens={availableTokens}
              loadingTokens={loadingTokens}
              tokenLoadError={tokenLoadError}
              onTokenModeChange={onTokenModeChange}
              onSelectedGithubTokenChange={onSelectedGithubTokenChange}
              onNewGithubTokenChange={onNewGithubTokenChange}
            />
          )}
        </div>
      )}

      {gitRemoteMode === 'none' && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-900/50 dark:text-gray-400">
          {t('projectWizard.step3.noneInfo')}
        </div>
      )}
    </div>
  );
}

type CreateRepoFieldsProps = {
  name: string;
  org: string;
  isPrivate: boolean;
  defaultOrg: string;
  isCreating: boolean;
  onNameChange: (value: string) => void;
  onOrgChange: (value: string) => void;
  onPrivateChange: (value: boolean) => void;
};

function CreateRepoFields({
  name,
  org,
  isPrivate,
  defaultOrg,
  isCreating,
  onNameChange,
  onOrgChange,
  onPrivateChange,
}: CreateRepoFieldsProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/50">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
            {t('projectWizard.step3.create.org')}
          </label>
          <Input
            type="text"
            value={org}
            onChange={(event) => onOrgChange(event.target.value)}
            placeholder={defaultOrg}
            className="w-full"
            disabled={isCreating}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
            {t('projectWizard.step3.create.name')}
          </label>
          <Input
            type="text"
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            placeholder="my-new-repo"
            className="w-full"
            disabled={isCreating}
          />
        </div>
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input
          type="checkbox"
          checked={isPrivate}
          onChange={(event) => onPrivateChange(event.target.checked)}
          disabled={isCreating}
          className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
        />
        {t('projectWizard.step3.create.private')}
      </label>
    </div>
  );
}

type PickRepoFieldsProps = {
  pickedRepo: GiteaRepoSummary | null;
  isCreating: boolean;
  onPickedRepoChange: (repo: GiteaRepoSummary | null) => void;
};

function PickRepoFields({ pickedRepo, isCreating, onPickedRepoChange }: PickRepoFieldsProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GiteaRepoSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isDisposed = false;
    setError(null);

    const timerId = window.setTimeout(async () => {
      setLoading(true);
      try {
        const data = await searchGiteaRepos(query);
        if (!isDisposed) setResults(data.repos);
      } catch (err) {
        if (!isDisposed) {
          setError(err instanceof Error ? err.message : 'Search failed');
          setResults([]);
        }
      } finally {
        if (!isDisposed) setLoading(false);
      }
    }, 250);

    return () => {
      isDisposed = true;
      window.clearTimeout(timerId);
    };
  }, [query]);

  return (
    <div className="space-y-3 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/50">
      <div>
        <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
          {t('projectWizard.step3.pick.search')}
        </label>
        <Input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('projectWizard.step3.pick.searchPlaceholder', {
            defaultValue: 'Search repos…',
          })}
          className="w-full"
          disabled={isCreating}
        />
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('projectWizard.step3.pick.loading')}
        </div>
      )}

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

      {!loading && !error && results.length > 0 && (
        <div className="max-h-56 overflow-y-auto rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
          {results.map((repo) => {
            const selected = pickedRepo?.id === repo.id;
            return (
              <button
                key={repo.id}
                type="button"
                onClick={() => onPickedRepoChange(selected ? null : repo)}
                disabled={isCreating}
                className={`flex w-full items-start gap-2 border-b border-gray-100 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700 ${
                  selected ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                }`}
              >
                <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center">
                  {selected ? (
                    <Check className="h-4 w-4 text-blue-500" />
                  ) : (
                    <GitBranch className="h-3 w-3 text-gray-400" />
                  )}
                </span>
                <span className="flex-1">
                  <span className="block font-medium text-gray-900 dark:text-white">
                    {repo.full_name}
                    {repo.private && (
                      <span className="ml-1 rounded bg-gray-200 px-1 text-[10px] font-normal text-gray-700 dark:bg-gray-700 dark:text-gray-300">
                        private
                      </span>
                    )}
                  </span>
                  {repo.description && (
                    <span className="block text-xs text-gray-500 dark:text-gray-400">
                      {repo.description}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {!loading && !error && results.length === 0 && query.trim() !== '' && (
        <p className="text-xs text-gray-500">{t('projectWizard.step3.pick.empty')}</p>
      )}

      {pickedRepo && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-2 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-200">
          {t('projectWizard.step3.pick.selected', { defaultValue: 'Selected:' })}{' '}
          <span className="font-mono">{pickedRepo.full_name}</span>
        </div>
      )}
    </div>
  );
}
