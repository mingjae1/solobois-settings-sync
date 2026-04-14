import * as vscode from 'vscode';
import type { AppContext } from '../context';
import {
    downloadSettings,
    ensureLoggedIn,
    fullSync,
    showGistHistory,
    uploadSettings
} from '../sync/coreSyncService';
import { getInstalledUserExtensionIds } from '../sync/profileManager';
import { notify, requireAuth, requireGistId } from '../notify';

export function registerSyncCommands(context: vscode.ExtensionContext, ctx: AppContext): void {
    const {
        extensionContext,
        authManager,
        gistService,
        settingsManager,
        autoUploadController,
        updateStatusBar,
        diffDocumentStore
    } = ctx;

    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.uploadNow', async () => {
            await ensureLoggedIn(ctx);
            await uploadSettings(ctx, extensionContext);
        }),
        vscode.commands.registerCommand('soloboisSettingsSync.downloadNow', async () => {
            await ensureLoggedIn(ctx);
            await downloadSettings(ctx, extensionContext, autoUploadController);
        }),
        vscode.commands.registerCommand('soloboisSettingsSync.syncNow', async () => {
            await ensureLoggedIn(ctx);
            await fullSync(ctx, extensionContext, autoUploadController);
        }),
        vscode.commands.registerCommand('soloboisSettingsSync.showHistory', async () => {
            await ensureLoggedIn(ctx);
            await showGistHistory(ctx, extensionContext);
        }),
        vscode.commands.registerCommand('soloboisSettingsSync.showLocalVsRemoteDiff', async () => {
            const token = await requireAuth(authManager);
            if (!token) { return; }
            const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
            const gistId = requireGistId(config);
            if (!gistId) { return; }
            updateStatusBar('downloading');
            try {
                const gistData = await gistService.getGist(gistId, token);
                if (!gistData?.files) {
                    throw new Error('Invalid Gist data');
                }

                const filesToDiff: { filename: string; remote: string; local: string }[] = [];

                if (gistData.files['settings.json']) {
                    const remote = gistData.files['settings.json'].content || '{}';
                    const local = settingsManager.readLocalSettings() || '{}';
                    filesToDiff.push({ filename: 'settings.json', remote, local });
                }

                if (gistData.files['keybindings.json']) {
                    const remote = gistData.files['keybindings.json'].content || '[]';
                    const local = settingsManager.readLocalKeybindings() || '[]';
                    filesToDiff.push({ filename: 'keybindings.json', remote, local });
                }

                if (gistData.files['extensions.json']) {
                    const remote = gistData.files['extensions.json'].content || '[]';
                    const localExtIds = [...getInstalledUserExtensionIds()].map(id => ({ id }));
                    const local = JSON.stringify(localExtIds, null, 2);
                    filesToDiff.push({ filename: 'extensions.json', remote, local });
                }

                if (filesToDiff.length === 0) {
                    void notify.info('No files to diff.');
                    return;
                }

                for (const file of filesToDiff) {
                    let remoteFormatted = file.remote;
                    let localFormatted = file.local;
                    try { remoteFormatted = JSON.stringify(JSON.parse(file.remote), null, 2); } catch {}
                    try { localFormatted = JSON.stringify(JSON.parse(file.local), null, 2); } catch {}

                    const remotePath = `/remote-${file.filename}`;
                    const localPath = `/local-${file.filename}`;
                    diffDocumentStore.set(remotePath, remoteFormatted);
                    diffDocumentStore.set(localPath, localFormatted);

                    const leftUri = vscode.Uri.parse(`soloboi-diff:${remotePath}`).with({ query: Date.now().toString() });
                    const rightUri = vscode.Uri.parse(`soloboi-diff:${localPath}`).with({ query: Date.now().toString() });

                    await vscode.commands.executeCommand(
                        'vscode.diff',
                        leftUri, rightUri,
                        `${file.filename}  Remote (Gist) vs Local`,
                        { preview: filesToDiff.length === 1 }
                    );
                }
            } catch (err: any) {
                void notify.error(`Diff failed: ${err.message}`);
            } finally {
                updateStatusBar('idle');
            }
        })
    );
}
