import * as vscode from 'vscode';
import type { AppContext } from '../../context';
import { notify } from '../../notify';
import {
    getSafePrivateExtensions,
    normalizePrivateExtensionId,
    type PrivateExtensionEntry
} from '../../privateExtensions/registry';
import { getExtensionLocalPath } from '../../privateExtensions/vsixInstaller';

export function registerRegisterPrivateExtCommand(
    context: vscode.ExtensionContext,
    ctx: AppContext
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.registerPrivateExtension', async () => {
            const cfg = vscode.workspace.getConfiguration('soloboisSettingsSync');
            const existing = getSafePrivateExtensions(cfg);
            const existingIds = new Set(existing.map((e: any) => normalizePrivateExtensionId(e.id ?? '')));

            const unknownExts = vscode.extensions.all.filter(ext =>
                !ext.id.startsWith('vscode.') &&
                !existingIds.has(normalizePrivateExtensionId(ext.id))
            );

            const idInput = await vscode.window.showQuickPick(
                [
                    ...unknownExts.map(ext => ({
                        label: ext.id,
                        description: `v${ext.packageJSON?.version ?? '?'} (installed)`,
                        id: ext.id,
                        version: ext.packageJSON?.version ?? '0.0.0'
                    })),
                    { label: '$(edit) Enter manually...', description: '', id: '__manual__', version: '' }
                ],
                {
                    title: 'Register Private Extension - Step 1: Select Extension',
                    placeHolder: 'Choose an installed extension or enter manually'
                }
            );
            if (!idInput) { return; }

            let extId = idInput.id;
            let extVersion = idInput.version;

            if (extId === '__manual__') {
                const manual = await vscode.window.showInputBox({
                    title: 'Extension ID',
                    prompt: 'Enter the full extension ID (publisher.extensionname)',
                    placeHolder: 'mycompany.my-tool'
                });
                if (!manual) { return; }
                extId = manual.trim();

                const verInput = await vscode.window.showInputBox({
                    title: 'Extension Version',
                    prompt: 'Enter the current version',
                    placeHolder: '1.0.0'
                });
                extVersion = (verInput ?? '').trim() || '0.0.0';
            }

            const syncSource = await vscode.window.showQuickPick(
                [
                    { label: 'Gist (Tier 1)', value: 'gist', detail: 'Upload VSIX into sync Gist.' },
                    { label: 'VSIX URL (Tier 3)', value: 'url', detail: 'Install from direct VSIX URL.' },
                    { label: 'Manual only', value: 'manual', detail: 'No auto-install source.' }
                ],
                {
                    title: 'Register Private Extension - Step 2: Choose Sync Method',
                    placeHolder: 'Choose how this extension should be synced'
                }
            );
            if (!syncSource) { return; }

            const entry: PrivateExtensionEntry = { id: extId, version: extVersion };

            if (syncSource.value === 'url') {
                const vsixUrl = await vscode.window.showInputBox({
                    title: 'Register Private Extension - VSIX URL',
                    prompt: 'Enter a direct VSIX download URL.',
                    placeHolder: 'https://example.com/my-tool-1.0.0.vsix'
                });
                if (!vsixUrl?.trim()) { return; }
                entry.vsixUrl = vsixUrl.trim();
            }

            const note = await vscode.window.showInputBox({
                title: 'Register Private Extension - Note (optional)',
                prompt: 'Add a note for this extension (e.g. ownership/contact).',
                placeHolder: 'Internal tool - contact platform team'
            });
            if (note?.trim()) { entry.note = note.trim(); }

            let registeredEntry = entry;

            if (syncSource.value === 'gist') {
                const gistId = cfg.get<string>('gistId', '');
                if (!gistId) {
                    void notify.warn(`"${extId}" registered for Gist sync, but no Gist ID is configured yet. Run "Set Gist ID" and then "Upload VSIX to Gist".`);
                } else {
                    const uploadNow = await vscode.window.showQuickPick(
                        [
                            { label: 'Upload now', value: true },
                            { label: 'Later', value: false }
                        ],
                        {
                            title: 'Register Private Extension - Gist Upload',
                            placeHolder: 'Upload a VSIX now to complete Tier 1 setup?'
                        }
                    );

                    if (uploadNow?.value) {
                        const token = await ctx.authManager.getToken();
                        if (!token) {
                            void notify.warn(`"${extId}" registered. Login required before uploading VSIX to Gist.`);
                        } else {
                            const uris = await vscode.window.showOpenDialog({
                                title: 'Upload VSIX to Gist - Select VSIX File',
                                filters: { 'VSIX Package': ['vsix'] },
                                canSelectMany: false,
                                openLabel: 'Upload'
                            });
                            if (uris && uris.length > 0) {
                                const gistFileKey = await ctx.gistService.uploadPrivateVsix(gistId, extId, uris[0].fsPath, token);
                                registeredEntry = { ...entry, syncGistKey: gistFileKey };
                                ctx.outputChannel.appendLine(`[Private Extensions] Uploaded VSIX to Gist: ${extId} -> ${gistFileKey}`);
                            }
                        }
                    }
                }
            }

            const rawExisting: any[] = cfg.get('privateExtensions', []);
            const updated = [
                ...rawExisting.filter((e: any) => normalizePrivateExtensionId(e?.id || '') !== normalizePrivateExtensionId(extId)),
                registeredEntry
            ];
            await cfg.update('privateExtensions', updated, vscode.ConfigurationTarget.Global);

            const localPath = getExtensionLocalPath(extId, extVersion);
            void notify.info(`"${extId}" registered. Sync method: ${syncSource.value}.`);
            ctx.outputChannel.appendLine(`[Private Extensions] Registered: ${extId} v${extVersion}`);
            if (!registeredEntry.vsixUrl && !registeredEntry.syncGistKey) {
                ctx.outputChannel.appendLine(`  Manual install path hint: ${localPath}`);
            }
            ctx.treeProvider.refresh();
        })
    );
}
