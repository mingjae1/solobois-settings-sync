import * as vscode from 'vscode';
import type { AppContext } from '../context';
import { normalizeExtensionIds } from '../utils';
import { cleanupIgnoredExtensions, saveCurrentProfileFromGlobal } from '../sync/profileManager';

export function registerConfigCommands(context: vscode.ExtensionContext, ctx: AppContext): void {
    const {
        treeProvider,
        settingsManager
    } = ctx;

    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.configureIgnoredExtensions', async () => {
            const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
            await cleanupIgnoredExtensions();
            const currentlyIgnored = new Set(
                normalizeExtensionIds(config.get<string[]>('ignoredExtensions', []))
            );

            const extensions = vscode.extensions.all
                .filter(ext => !ext.packageJSON?.isBuiltin && ext.id !== 'soloboi.solobois-settings-sync')
                .map(ext => ({
                    label: ext.packageJSON?.displayName || ext.packageJSON?.name || ext.id,
                    description: ext.id,
                    picked: currentlyIgnored.has(ext.id.toLowerCase())
                }))
                .sort((a, b) => a.label.localeCompare(b.label));

            const selected = await vscode.window.showQuickPick(extensions, {
                canPickMany: true,
                placeHolder: 'Select extensions to exclude from sync.',
                title: 'Manage Ignored Extensions'
            });

            if (selected !== undefined) {
                const newIgnored = normalizeExtensionIds(selected.map(item => item.description || ''));
                await config.update('ignoredExtensions', newIgnored, vscode.ConfigurationTarget.Global);
                await saveCurrentProfileFromGlobal(config);
                vscode.window.showInformationMessage("Soloboi's Settings Sync: Ignored extensions updated.");
                treeProvider.refresh();
            }
        }),
        vscode.commands.registerCommand('soloboisSettingsSync.configureIgnoredSettings', async () => {
            const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
            const currentlyIgnored = new Set(config.get<string[]>('ignoredSettings', []));

            const localObj = settingsManager.getLocalSettingsObject();
            const keys = new Set([...Object.keys(localObj), ...currentlyIgnored]);

            const sortedKeys = Array.from(keys).sort();
            const items: (vscode.QuickPickItem & { isPattern?: boolean })[] = [
                {
                    label: '$(add) Enter custom pattern...',
                    description: 'Enter a specific setting key or wildcard pattern (*).',
                    alwaysShow: true,
                    isPattern: true
                },
                {
                    label: 'Current settings and ignored list',
                    kind: vscode.QuickPickItemKind.Separator
                }
            ];

            let lastPrefix = '';
            for (const key of sortedKeys) {
                const prefix = key.split('.')[0] || 'other';
                if (prefix !== lastPrefix) {
                    items.push({
                        label: prefix,
                        kind: vscode.QuickPickItemKind.Separator
                    });
                    lastPrefix = prefix;
                }
                items.push({
                    label: key,
                    picked: currentlyIgnored.has(key)
                });
            }

            const selected = await vscode.window.showQuickPick(items, {
                canPickMany: true,
                placeHolder: 'Select settings to ignore or add a custom pattern.',
                title: 'Manage Ignored Settings'
            });

            if (selected !== undefined) {
                const finalIgnored = new Set<string>();
                let needsManualInput = false;

                for (const item of selected) {
                    if (item.isPattern) {
                        needsManualInput = true;
                    } else {
                        finalIgnored.add(item.label);
                    }
                }

                if (needsManualInput) {
                    const customPattern = await vscode.window.showInputBox({
                        title: 'Add Ignore Pattern',
                        prompt: 'Enter a setting key or wildcard pattern to ignore (e.g. terminal.integrated.*)',
                        placeHolder: 'e.g. editor.fontSize'
                    });
                    if (customPattern) {
                        finalIgnored.add(customPattern);
                    }
                }

                await config.update('ignoredSettings', Array.from(finalIgnored), vscode.ConfigurationTarget.Global);
                await saveCurrentProfileFromGlobal(config);
                vscode.window.showInformationMessage("Soloboi's Settings Sync: Ignored settings updated.");
                treeProvider.refresh();
            }
        }),
        vscode.commands.registerCommand('soloboisSettingsSync.pickUserDataDir', async () => {
            const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
            const action = await vscode.window.showQuickPick(
                [
                    { label: 'Select Directory...', value: 'select' },
                    { label: 'Clear Override', value: 'clear' }
                ],
                {
                    title: 'Select User Data Directory',
                    placeHolder: 'Choose where settings.json/keybindings.json are located.'
                }
            );
            if (!action) {
                return;
            }

            if (action.value === 'clear') {
                await config.update('userDataDir', '', vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage("Soloboi's Settings Sync: userDataDir override cleared.");
                treeProvider.refresh();
                return;
            }

            const selected = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Use this directory'
            });
            if (!selected || selected.length === 0) {
                return;
            }

            await config.update('userDataDir', selected[0].fsPath, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage("Soloboi's Settings Sync: userDataDir updated.");
            treeProvider.refresh();
        }),
        vscode.commands.registerCommand('soloboisSettingsSync.pickExtensionsDir', async () => {
            const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
            const action = await vscode.window.showQuickPick(
                [
                    { label: 'Select Directory...', value: 'select' },
                    { label: 'Clear Override', value: 'clear' }
                ],
                {
                    title: 'Select Extensions Directory',
                    placeHolder: 'Choose where extension folders are located.'
                }
            );
            if (!action) {
                return;
            }

            if (action.value === 'clear') {
                await config.update('extensionsDir', '', vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage("Soloboi's Settings Sync: extensionsDir override cleared.");
                treeProvider.refresh();
                return;
            }

            const selected = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Use this directory'
            });
            if (!selected || selected.length === 0) {
                return;
            }

            await config.update('extensionsDir', selected[0].fsPath, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage("Soloboi's Settings Sync: extensionsDir updated.");
            treeProvider.refresh();
        }),
        vscode.commands.registerCommand('soloboisSettingsSync.pickAdditionalFiles', async () => {
            const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
            const action = await vscode.window.showQuickPick(
                [
                    { label: 'Add Files...', value: 'add' },
                    { label: 'Replace File List...', value: 'replace' },
                    { label: 'Clear File List', value: 'clear' }
                ],
                {
                    title: 'Manage Additional Sync Files',
                    placeHolder: 'Select additional files included in Gist sync.'
                }
            );
            if (!action) {
                return;
            }

            if (action.value === 'clear') {
                await config.update('additionalFiles', [], vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage("Soloboi's Settings Sync: additionalFiles cleared.");
                treeProvider.refresh();
                return;
            }

            const selected = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: true,
                openLabel: action.value === 'replace' ? 'Replace with selected files' : 'Add selected files'
            });
            if (!selected || selected.length === 0) {
                return;
            }

            const picked = selected.map(uri => uri.fsPath);
            const existing = config.get<string[]>('additionalFiles', []);
            const next = action.value === 'replace'
                ? Array.from(new Set(picked))
                : Array.from(new Set([...existing, ...picked]));

            await config.update('additionalFiles', next, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(
                `Soloboi's Settings Sync: additionalFiles updated (${next.length} file(s)).`
            );
            treeProvider.refresh();
        })
    );
}
