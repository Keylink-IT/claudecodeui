import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project } from '../../types/app';
import { api } from '../../utils/api';
import { usePrdDocument } from './hooks/usePrdDocument';
import { usePrdKeyboardShortcuts } from './hooks/usePrdKeyboardShortcuts';
import { usePrdRegistry } from './hooks/usePrdRegistry';
import { usePrdSave } from './hooks/usePrdSave';
import type { PrdFile } from './types';
import { ensurePrdExtension } from './utils/fileName';
import OverwriteConfirmModal from './view/OverwriteConfirmModal';
import PrdEditorLoadingState from './view/PrdEditorLoadingState';
import PrdEditorWorkspace from './view/PrdEditorWorkspace';

type PRDEditorProps = {
  file?: PrdFile | null;
  onClose: () => void;
  projectPath?: string;
  project?: Project | null;
  initialContent?: string;
  isNewFile?: boolean;
  onSave?: () => Promise<void> | void;
  onSendToChat?: (prompt: string) => void;
};

export default function PRDEditor({
  file,
  onClose,
  projectPath,
  project,
  initialContent = '',
  isNewFile = false,
  onSave,
  onSendToChat,
}: PRDEditorProps) {
  const [showOverwriteConfirm, setShowOverwriteConfirm] = useState<boolean>(false);
  const [overwriteFileName, setOverwriteFileName] = useState<string>('');
  const [submittingForge, setSubmittingForge] = useState<boolean>(false);
  const [forgeSubmitSuccess, setForgeSubmitSuccess] = useState<boolean>(false);
  const forgeSuccessTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { content, setContent, fileName, setFileName, loading, loadError } = usePrdDocument({
    file,
    isNewFile,
    initialContent,
    projectPath,
  });

  // PRD hooks are addressed by DB `projectId` in 1.33; the backend resolves the
  // `.taskmaster/docs` folder from the `projects` table.
  const { existingPrds, refreshExistingPrds } = usePrdRegistry({
    projectId: project?.projectId,
  });

  const isExistingFile = useMemo(() => !isNewFile || Boolean(file?.isExisting), [file?.isExisting, isNewFile]);

  const { savePrd, saving, saveSuccess } = usePrdSave({
    projectId: project?.projectId,
    existingPrds,
    isExistingFile,
    onAfterSave: async () => {
      await refreshExistingPrds();
      await onSave?.();
    },
  });

  const handleDownload = useCallback(() => {
    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const downloadedFileName = ensurePrdExtension(fileName || 'prd');

    anchor.href = url;
    anchor.download = downloadedFileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, [content, fileName]);

  const handleSave = useCallback(
    async (allowOverwrite = false) => {
      const result = await savePrd({
        content,
        fileName,
        allowOverwrite,
      });

      if (result.status === 'needs-overwrite') {
        setOverwriteFileName(result.fileName);
        setShowOverwriteConfirm(true);
        return;
      }

      if (result.status === 'failed') {
        alert(result.message);
      }
    },
    [content, fileName, savePrd],
  );

  const confirmOverwrite = useCallback(async () => {
    setShowOverwriteConfirm(false);
    await handleSave(true);
  }, [handleSave]);

  // Listen for AI-generated PRD content coming back from the chat session.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ content: string }>).detail;
      if (detail?.content) {
        setContent(detail.content);
      }
    };
    window.addEventListener('prd:receive-content', handler);
    return () => window.removeEventListener('prd:receive-content', handler);
  }, [setContent]);

  const handleGenerateWithAI = useCallback(() => {
    if (!onSendToChat) return;
    // Set flag so the chat completion handler knows to pipe the response back.
    sessionStorage.setItem('prd:awaiting', 'true');
    const prompt = `Review this project's codebase and fill in the following PRD template with project-specific information. Analyze the code structure, dependencies, features, and architecture to produce a comprehensive Product Requirements Document.

Before writing, thoroughly explore the project: read key source files, check package.json / requirements.txt for dependencies, examine the directory structure, and understand what the project does and how it's built.

Instructions:
- Fill in every applicable section with actual information from this project
- Delete sections marked "INCLUDE IF" that don't apply to this project
- Keep the markdown formatting and table structures intact
- Be thorough but concise
- Output ONLY the filled-in PRD markdown, no preamble or explanation

Here is the template to fill in:

${content}`;
    onSendToChat(prompt);
  }, [content, onSendToChat]);

  const handleSubmitForge = useCallback(async () => {
    if (!content.trim()) {
      alert('Please add content to the PRD before submitting.');
      return;
    }
    setSubmittingForge(true);
    setForgeSubmitSuccess(false);
    try {
      const res = await api.forge.submit(fileName || 'untitled-prd', content);
      if (!res.ok) {
        const data = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(data.message || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setForgeSubmitSuccess(true);
      if (forgeSuccessTimer.current) clearTimeout(forgeSuccessTimer.current);
      forgeSuccessTimer.current = setTimeout(() => setForgeSubmitSuccess(false), 3000);
      // Open the file in Gitea in a new tab
      if (data.fileUrl) window.open(data.fileUrl, '_blank');
    } catch (err) {
      alert(`Submit to Forge failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setSubmittingForge(false);
    }
  }, [content, fileName]);

  usePrdKeyboardShortcuts({
    onSave: () => {
      void handleSave();
    },
    onClose,
  });

  if (loading) {
    return <PrdEditorLoadingState />;
  }

  return (
    <>
      <PrdEditorWorkspace
        content={content}
        onContentChange={setContent}
        fileName={fileName}
        onFileNameChange={setFileName}
        isNewFile={isNewFile}
        saving={saving}
        saveSuccess={saveSuccess}
        onSave={() => {
          void handleSave();
        }}
        onDownload={handleDownload}
        onClose={onClose}
        onSubmitForge={() => { void handleSubmitForge(); }}
        submittingForge={submittingForge}
        forgeSubmitSuccess={forgeSubmitSuccess}
        onGenerateWithAI={onSendToChat ? handleGenerateWithAI : undefined}
        loadError={loadError}
      />

      <OverwriteConfirmModal
        isOpen={showOverwriteConfirm}
        fileName={overwriteFileName || ensurePrdExtension(fileName || 'prd')}
        saving={saving}
        onCancel={() => setShowOverwriteConfirm(false)}
        onConfirm={() => {
          void confirmOverwrite();
        }}
      />
    </>
  );
}
