import * as vscode from 'vscode';
import { AuthManager } from '../auth';
import { GistService } from '../gistService';
import { SoloboiSyncTreeProvider } from '../treeProvider';
import { AUTO_UPLOAD_SUPPRESSION_BUFFER_MS } from '../constants';

type StatusBarState = 'idle' | 'uploading' | 'downloading' | 'logged-out' | 'error';

export class AutoUploadController {
    private uploadTimer: NodeJS.Timeout | undefined;
    private autoUploadSuspendedUntil = 0;

    constructor(private readonly outputChannel: vscode.OutputChannel) {}

    public getSuppressionWindow(config?: vscode.WorkspaceConfiguration): number {
        const cfg = config || vscode.workspace.getConfiguration('soloboisSettingsSync');
        const delay = Math.max(cfg.get<number>('autoUploadDelay', 5000), 0);
        return delay + AUTO_UPLOAD_SUPPRESSION_BUFFER_MS;
    }

    public suspend(durationMs: number): void {
        this.autoUploadSuspendedUntil = Math.max(
            this.autoUploadSuspendedUntil,
            Date.now() + Math.max(durationMs, 0)
        );
        this.clearPendingUpload();
    }

    public isSuspended(): boolean {
        return Date.now() < this.autoUploadSuspendedUntil;
    }

    public schedule(
        context: vscode.ExtensionContext,
        config: vscode.WorkspaceConfiguration,
        triggerReason: string,
        gistService: GistService,
        authManager: AuthManager,
        outputChannel: vscode.OutputChannel,
        treeProvider: SoloboiSyncTreeProvider,
        statusBarUpdater: (state: StatusBarState) => void,
        runUpload: () => Promise<void>,
        delayOverrideMs?: number
    ): void {
        void context;
        void gistService;
        void outputChannel;
        void treeProvider;
        void statusBarUpdater;

        if (this.isSuspended()) {
            return;
        }

        this.clearPendingUpload();
        const delayMs = typeof delayOverrideMs === 'number'
            ? Math.max(delayOverrideMs, 0)
            : Math.max(config.get<number>('autoUploadDelay', 5000), 0);

        this.uploadTimer = setTimeout(async () => {
            this.uploadTimer = undefined;
            try {
                if (this.isSuspended()) {
                    return;
                }

                const session = await authManager.getSessionSilent();
                if (session) {
                    await runUpload();
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                this.outputChannel.appendLine(
                    `Auto-upload timer failed (${triggerReason}): ${message}`
                );
            }
        }, delayMs);
    }

    private clearPendingUpload(): void {
        if (this.uploadTimer) {
            clearTimeout(this.uploadTimer);
            this.uploadTimer = undefined;
        }
    }

    public dispose(): void {
        this.clearPendingUpload();
        this.autoUploadSuspendedUntil = 0;
    }
}
