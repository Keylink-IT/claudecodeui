import { FileText, FolderPlus, GitBranch } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceType } from '../types';

type StepTypeSelectionProps = {
  workspaceType: WorkspaceType;
  onWorkspaceTypeChange: (workspaceType: WorkspaceType) => void;
};

type CardConfig = {
  type: WorkspaceType;
  icon: typeof FolderPlus;
  iconBg: string;
  iconColor: string;
  titleKey: string;
  descriptionKey: string;
};

const CARDS: CardConfig[] = [
  {
    type: 'existing',
    icon: FolderPlus,
    iconBg: 'bg-green-100 dark:bg-green-900/50',
    iconColor: 'text-green-600 dark:text-green-400',
    titleKey: 'projectWizard.step1.existing.title',
    descriptionKey: 'projectWizard.step1.existing.description',
  },
  {
    type: 'new',
    icon: GitBranch,
    iconBg: 'bg-purple-100 dark:bg-purple-900/50',
    iconColor: 'text-purple-600 dark:text-purple-400',
    titleKey: 'projectWizard.step1.new.title',
    descriptionKey: 'projectWizard.step1.new.description',
  },
  {
    type: 'from-prd',
    icon: FileText,
    iconBg: 'bg-amber-100 dark:bg-amber-900/50',
    iconColor: 'text-amber-600 dark:text-amber-400',
    titleKey: 'projectWizard.step1.fromPrd.title',
    descriptionKey: 'projectWizard.step1.fromPrd.description',
  },
];

export default function StepTypeSelection({
  workspaceType,
  onWorkspaceTypeChange,
}: StepTypeSelectionProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <h4 className="mb-3 text-sm font-medium text-gray-700 dark:text-gray-300">
        {t('projectWizard.step1.question')}
      </h4>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {CARDS.map((card) => {
          const Icon = card.icon;
          const selected = workspaceType === card.type;
          return (
            <button
              key={card.type}
              type="button"
              onClick={() => onWorkspaceTypeChange(card.type)}
              className={`rounded-lg border-2 p-4 text-left transition-all ${
                selected
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                  : 'border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600'
              }`}
            >
              <div className="flex items-start gap-3">
                <div
                  className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg ${card.iconBg}`}
                >
                  <Icon className={`h-5 w-5 ${card.iconColor}`} />
                </div>
                <div className="flex-1">
                  <h5 className="mb-1 font-semibold text-gray-900 dark:text-white">
                    {t(card.titleKey)}
                  </h5>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    {t(card.descriptionKey)}
                  </p>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
