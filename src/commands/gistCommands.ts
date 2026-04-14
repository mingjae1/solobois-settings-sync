import * as vscode from 'vscode';
import type { AppContext } from '../context';
import { notify } from '../notify';
import { sensitiveDataGuard } from '../sensitiveDataGuard';
import { parseGistIdFromInput } from '../utils';
import { saveCurrentProfileFromGlobal } from '../sync/profileManager';

export function registerGistCommands(context: vscode.ExtensionContext, ctx: AppContext): void {
    const {
        authManager,
        gistService,
        settingsManager,
        treeProvider,
        updateStatusBar,
        outputChannel
    } = ctx;

    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.setGistId', async (gistIdFromTree?: string) => {
            const config = vscode.workspace.getConfiguration('soloboisSettingsSync');

            if (typeof gistIdFromTree === 'string' && gistIdFromTree.trim().length > 0) {
                const parsedFromTree = parseGistIdFromInput(gistIdFromTree);
                if (parsedFromTree === null) {
                    void notify.warn('Please select a valid Gist from the sidebar.');
                    return;
                }
                await config.update('gistId', parsedFromTree, vscode.ConfigurationTarget.Global);
                await saveCurrentProfileFromGlobal(config);
                vscode.window.showInformationMessage(`Soloboi's Settings Sync: Gist ID updated. (${parsedFromTree.substring(0, 8)}...)`);
                treeProvider.refresh();
                return;
            }

            const currentId = config.get<string>('gistId') || '';
            const input = await vscode.window.showInputBox({
                title: 'Set Gist ID',
                prompt: 'Enter a GitHub Gist ID or Gist URL used for sync.',
                value: currentId,
                placeHolder: 'e.g. abc123def456... or https://gist.github.com/user/abc123def456',
                validateInput: (value) => {
                    const parsed = parseGistIdFromInput(value);
                    if (value && parsed === null) {
                        return 'Enter a valid Gist ID or Gist URL.';
                    }
                    return null;
                }
            });
            if (input !== undefined) {
                const parsed = parseGistIdFromInput(input);
                if (parsed === null) {
                    vscode.window.showErrorMessage("Soloboi's Settings Sync: Invalid Gist ID/URL.");
                    return;
                }
                await config.update('gistId', parsed, vscode.ConfigurationTarget.Global);
                await saveCurrentProfileFromGlobal(config);
                if (parsed) {
                    vscode.window.showInformationMessage(`Soloboi's Settings Sync: Gist ID updated. (${parsed.substring(0, 8)}...)`);
                } else {
                    vscode.window.showInformationMessage("Soloboi's Settings Sync: Gist ID cleared.");
                }
                treeProvider.refresh();
            }
        }),
        vscode.commands.registerCommand('soloboisSettingsSync.togglePublicGist', async () => {
            const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
            const current = config.get<boolean>('publicGist', false);
            await config.update('publicGist', !current, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(
                `Soloboi's Settings Sync: New Gists will be created as ${!current ? 'public' : 'private'}.`
            );
            treeProvider.refresh();
        }),
        vscode.commands.registerCommand('soloboisSettingsSync.shareSettings', async () => {
            const token = await authManager.getToken();
            if (!token) {
                vscode.window.showWarningMessage("Soloboi's Settings Sync: Please log in to GitHub first.");
                return;
            }

            // Fetch existing public sync gists
            const allGists: any[] = await gistService.getUserGists(token);
            const SHARE_PREFIX = "Soloboi's Settings Sync - ";
            const publicGists = allGists.filter(
                (g: any) => g.public === true && g.description?.startsWith(SHARE_PREFIX)
            );

            type ShareAction = vscode.QuickPickItem & { action: 'copy' | 'create'; gist?: any };
            const items: ShareAction[] = [
                ...publicGists.map((g: any) => ({
                    label: `$(link) ${g.description.replace(SHARE_PREFIX, '') || g.id}`,
                    description: `gist.github.com/${g.owner?.login ?? ''}/${g.id}`,
                    action: 'copy' as const,
                    gist: g
                })),
                {
                    label: '$(add) Create new public snapshot...',
                    description: 'Uploads a public copy of your current settings (secrets masked)',
                    action: 'create' as const
                }
            ];

            const picked = await vscode.window.showQuickPick(items as any[], {
                title: 'Share Your Settings',
                placeHolder: publicGists.length > 0
                    ? 'Select a shared gist to copy its URL, or create a new one'
                    : 'No public gists yet - create one to share your settings'
            });
            if (!picked) { return; }

            const p = picked as ShareAction;

            if (p.action === 'copy' && p.gist) {
                // Also offer rename
                const url = `https://gist.github.com/${p.gist.owner?.login ?? ''}/${p.gist.id}`;
                const choice = await vscode.window.showQuickPick(
                    [
                        { label: '$(clippy) Copy Share URL', value: 'copy' },
                        { label: '$(edit) Rename this Gist', value: 'rename' }
                    ],
                    { title: p.gist.description?.replace(SHARE_PREFIX, '') || p.gist.id }
                );
                if (!choice) { return; }
                if (choice.value === 'copy') {
                    await vscode.env.clipboard.writeText(url);
                    vscode.window.showInformationMessage(
                        `Soloboi's Settings Sync: Link copied! Share it with friends!\n${url}`
                    );
                } else {
                    const newName = await vscode.window.showInputBox({
                        title: 'Rename Gist',
                        prompt: 'Enter a new name for this shared gist.',
                        value: p.gist.description?.replace(SHARE_PREFIX, '') || ''
                    });
                    if (!newName) { return; }
                    await gistService.updateGist(p.gist.id, {}, token, SHARE_PREFIX + newName.trim());
                    vscode.window.showInformationMessage(
                        `Soloboi's Settings Sync: Gist renamed to "${newName.trim()}".`
                    );
                    treeProvider.refresh();
                }
                return;
            }

            // Create new public snapshot
            updateStatusBar('uploading');
            try {
                const rawSettings = settingsManager.readLocalSettings() || '{}';
                const { result: maskedSettings } = sensitiveDataGuard.redactJsonString(rawSettings, 'public');

                const nameInput = await vscode.window.showInputBox({
                    title: 'Share Your Settings - Name',
                    prompt: 'Give this snapshot a name (shown in the Gist description).',
                    placeHolder: 'My VS Code Setup',
                    value: 'My VS Code Setup'
                });
                if (nameInput === undefined) { return; }

                const description = SHARE_PREFIX + (nameInput.trim() || 'My VS Code Setup');
                const gistData = await gistService.createGist(
                    description,
                    { 'settings.json': { content: maskedSettings } },
                    token,
                    true
                );

                const url = `https://gist.github.com/${(gistData as any)?.owner?.login ?? ''}/${gistData?.id}`;
                await vscode.env.clipboard.writeText(url);
                vscode.window.showInformationMessage(
                    `Soloboi's Settings Sync: Settings shared! URL copied!\n${url}`,
                    'Open in Browser'
                ).then(sel => {
                    if (sel === 'Open in Browser') {
                        vscode.env.openExternal(vscode.Uri.parse(url));
                    }
                });
                outputChannel.appendLine(`[Share] Created public settings gist: ${url}`);
                treeProvider.refresh();
            } catch (err: any) {
                vscode.window.showErrorMessage(
                    `Soloboi's Settings Sync: Share failed: ${err?.message ?? err}`
                );
            } finally {
                updateStatusBar('idle');
            }
        })
    );
}
