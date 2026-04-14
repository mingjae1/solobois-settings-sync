import * as vscode from 'vscode';
import type { AppContext } from '../../context';
import { notify, requireAuth, requireGistId } from '../../notify';
import { normalizePrivateExtensionId } from '../../privateExtensions/registry';

export function registerUploadVsixToGistCommand(
    context: vscode.ExtensionContext,
    ctx: AppContext
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.uploadPrivateVsixToGist', async () => {
            const cfg = vscode.workspace.getConfiguration('soloboisSettingsSync');
            const gistId = requireGistId(cfg);
            if (!gistId) { return; }

            const privateExts: any[] = cfg.get('privateExtensions', []);
            if (privateExts.length === 0) {
                void notify.error('No private extensions registered. Register one first.');
                return;
            }

            const extPick = await vscode.window.showQuickPick(
                privateExts.map((e: any) => ({
                    label: e.id ?? '',
                    description: `v${e.version ?? '?'}`,
                    id: e.id ?? ''
                })),
                { title: 'Upload VSIX to Gist - Step 1: Select Extension', placeHolder: 'Choose the private extension' }
            );
            if (!extPick) { return; }

            const uris = await vscode.window.showOpenDialog({
                title: 'Upload VSIX to Gist - Step 2: Select VSIX File',
                filters: { 'VSIX Package': ['vsix'] },
                canSelectMany: false,
                openLabel: 'Upload'
            });
            if (!uris || uris.length === 0) { return; }

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Uploading ${extPick.id} VSIX to Gist...`,
                    cancellable: false
                },
                async () => {
                    try {
                        const token = await requireAuth(ctx.authManager);
                        if (!token) { return; }

                        const gistFileKey = await ctx.gistService.uploadPrivateVsix(gistId, extPick.id, uris[0].fsPath, token);
                        const updated = privateExts.map((e: any) =>
                            normalizePrivateExtensionId(e.id ?? '') === normalizePrivateExtensionId(extPick.id)
                                ? { ...e, syncGistKey: gistFileKey }
                                : e
                        );
                        await cfg.update('privateExtensions', updated, vscode.ConfigurationTarget.Global);
                        ctx.outputChannel.appendLine(`[Private Extensions] Uploaded VSIX to Gist: ${extPick.id} -> ${gistFileKey}`);
                        void notify.info(`"${extPick.id}" VSIX uploaded to Gist. It will be auto-installed on other machines during sync.`);
                        ctx.treeProvider.refresh();
                    } catch (err: unknown) {
                        const msg = err instanceof Error ? err.message : String(err);
                        ctx.outputChannel.appendLine(`[Private Extensions] VSIX upload failed: ${msg}`);
                        void notify.error(`VSIX upload failed - ${msg}`);
                    }
                }
            );
        })
    );
}
