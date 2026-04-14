import * as vscode from 'vscode';
import type { AppContext } from '../context';
import {
    applyProfileToGlobalSettings,
    cleanupIgnoredExtensions,
    getCurrentGlobalSyncState,
    getCurrentProfileName,
    normalizeProfiles,
    saveCurrentProfileFromGlobal
} from '../sync/profileManager';

export function registerProfileCommands(context: vscode.ExtensionContext, ctx: AppContext): void {
    const { treeProvider } = ctx;

    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.switchProfile', async () => {
            const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
            await saveCurrentProfileFromGlobal(config);

            const profiles = normalizeProfiles(config.get<Record<string, unknown>>('profiles', {}));
            const currentProfile = getCurrentProfileName(config);
            const profileNames = Object.keys(profiles).sort((a, b) => a.localeCompare(b));

            const items: (vscode.QuickPickItem & { profileName?: string; createNew?: boolean })[] = profileNames.map(name => ({
                label: name === currentProfile ? `$(check) ${name}` : name,
                description: name === currentProfile ? 'Current profile' : undefined,
                profileName: name
            }));

            items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
            items.push({
                label: '$(add) Create New Profile',
                description: 'Create from current gist/ignore settings.',
                createNew: true
            });

            const selected = await vscode.window.showQuickPick(items, {
                title: 'Switch Sync Profile',
                placeHolder: 'Select a profile or create a new one'
            });

            if (!selected) {
                return;
            }

            let nextProfileName = selected.profileName || '';
            const nextProfiles = { ...profiles };

            if (selected.createNew) {
                const input = await vscode.window.showInputBox({
                    title: 'New Profile Name',
                    prompt: 'Enter a profile name',
                    validateInput: (value) => {
                        const name = value.trim();
                        if (!name) {
                            return 'Profile name is required.';
                        }
                        if (nextProfiles[name]) {
                            return 'A profile with this name already exists.';
                        }
                        return null;
                    }
                });

                if (!input) {
                    return;
                }

                nextProfileName = input.trim();
                nextProfiles[nextProfileName] = getCurrentGlobalSyncState(config);
            }

            if (!nextProfileName) {
                return;
            }

            await config.update('profiles', nextProfiles, vscode.ConfigurationTarget.Global);
            await config.update('currentProfile', nextProfileName, vscode.ConfigurationTarget.Global);
            await applyProfileToGlobalSettings(nextProfileName, config);
            await cleanupIgnoredExtensions();
            await saveCurrentProfileFromGlobal(config);

            treeProvider.refresh();
            vscode.window.showInformationMessage(`Soloboi's Settings Sync: Switched to profile "${nextProfileName}".`);
        })
    );
}
