import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

/**
 * Session synchronizer for Orchestration ("Agent SDK") — intentionally a no-op.
 *
 * Orchestration runs the Claude Code CLI against the SHARED ~/.claude config dir
 * (it uses the user's ambient Claude auth, so it cannot isolate the dir the way
 * DeepSeek does). The claude synchronizer already scans ~/.claude and indexes those
 * transcripts, so a second synchronizer here would double-index the same files.
 * Orchestration turns are attributed via the session row created at
 * `POST /api/providers/sessions` (provider = 'orchestration') and the live stream's
 * provider tag; on-disk transcripts are indexed once by claude.
 */
export class OrchestrationSessionSynchronizer implements IProviderSessionSynchronizer {
  async synchronize(_since?: Date): Promise<number> {
    return 0;
  }

  async synchronizeFile(_filePath: string): Promise<string | null> {
    return null;
  }
}
