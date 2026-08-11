import { Fragment } from 'react';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { WizardStep, WorkspaceType } from '../types';

type WizardProgressProps = {
  step: WizardStep;
  workspaceType: WorkspaceType;
};

export default function WizardProgress({ step, workspaceType }: WizardProgressProps) {
  const { t } = useTranslation();
  // Steps 4 (Console project) and 5 (Environments) only apply to from-prd.
  // Other workspace types skip directly from step 3 (git remote) to step 6 (review).
  const showPrdSteps = workspaceType === 'from-prd';
  const steps: WizardStep[] = showPrdSteps ? [1, 2, 3, 4, 5, 6] : [1, 2, 3, 6];

  const labelKey = (currentStep: WizardStep) => {
    switch (currentStep) {
      case 1:
        return 'projectWizard.steps.type';
      case 2:
        return 'projectWizard.steps.configure';
      case 3:
        return 'projectWizard.steps.gitRemote';
      case 4:
        return 'projectWizard.steps.console';
      case 5:
        return 'projectWizard.steps.environments';
      case 6:
      default:
        return 'projectWizard.steps.confirm';
    }
  };

  const labelDefault = (currentStep: WizardStep) => {
    switch (currentStep) {
      case 1:
        return 'Type';
      case 2:
        return 'Configure';
      case 3:
        return 'Git';
      case 4:
        return 'Console';
      case 5:
        return 'Env';
      case 6:
      default:
        return 'Confirm';
    }
  };

  return (
    <div className="px-6 pb-2 pt-4">
      <div className="flex items-center justify-between">
        {steps.map((currentStep, index) => (
          <Fragment key={currentStep}>
            <div className="flex items-center gap-2">
              <div
                className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium ${
                  currentStep < step
                    ? 'bg-green-500 text-white'
                    : currentStep === step
                      ? 'bg-blue-500 text-white'
                      : 'bg-gray-200 text-gray-500 dark:bg-gray-700'
                }`}
              >
                {currentStep < step ? <Check className="h-4 w-4" /> : index + 1}
              </div>
              <span className="hidden text-sm font-medium text-gray-700 dark:text-gray-300 sm:inline">
                {t(labelKey(currentStep), { defaultValue: labelDefault(currentStep) })}
              </span>
            </div>

            {index < steps.length - 1 && (
              <div
                className={`mx-2 h-1 flex-1 rounded ${
                  currentStep < step ? 'bg-green-500' : 'bg-gray-200 dark:bg-gray-700'
                }`}
              />
            )}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
