import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { AuthManager } from './auth';
import { GistService } from './gistService';
import { SettingsManager } from './settingsManager';
import { SoloboiSyncTreeProvider } from './treeProvider';
import { detectPlatform, Platform } from './platformDetector';
import { checkMarketplaceForPlatform, ExtensionAvailability } from './marketplaceChecker';

const GIST_DESCRIPTION_PREFIX = "Soloboi's Settings Sync - ";
const GIST_DEFAULT_DESCRIPTION = "Soloboi's Settings Sync - VS Code Settings"; // Used for initial creation
const LAST_SYNC_KEY = 'soloboisSettingsSync.lastSyncTimestamp';
const DEFAULT_PROFILE_NAME = 'Default';

let authManager: AuthManager;
let gistService: GistService;
let settingsManager: SettingsManager;
let fileWatcher: vscode.FileSystemWatcher | undefined;
let uploadTimer: NodeJS.Timeout | undefined;
let isUploading = false;
let isDownloading = false;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let lastSyncTime: string | null = null;
let currentPlatform: Platform = 'unknown';

type OmissionSummary = {
    skippedSettingKeys: string[];
    skippedAntigravityFiles: string[];
};

type SyncProfile = {
    gistId: string;
    ignoredSettings: string[];
    ignoredExtensions: string[];
};

function normalizeIgnoredSettings(keys: string[]): string[] {
    const seen = new Set<string>();
    const normalized: string[] = [];

    for (const raw of keys) {
        const key = (raw || '').trim();
        if (!key || seen.has(key)) {
            continue;
        }
        seen.add(key);
        normalized.push(key);
    }

    return normalized;
}

function normalizeExtensionIds(ids: string[]): string[] {
    const seen = new Set<string>();
    const normalized: string[] = [];

    for (const raw of ids) {
        const id = (raw || '').trim().toLowerCase();
        if (!id || seen.has(id)) {
            continue;
        }
        seen.add(id);
        normalized.push(id);
    }

    return normalized;
}

function getCurrentProfileName(config: vscode.WorkspaceConfiguration): string {
    const raw = (config.get<string>('currentProfile', DEFAULT_PROFILE_NAME) || '').trim();
    return raw || DEFAULT_PROFILE_NAME;
}

function getCurrentGlobalSyncState(config: vscode.WorkspaceConfiguration): SyncProfile {
    return {
        gistId: (config.get<string>('gistId', '') || '').trim(),
        ignoredSettings: normalizeIgnoredSettings(config.get<string[]>('ignoredSettings', [])),
        ignoredExtensions: normalizeExtensionIds(config.get<string[]>('ignoredExtensions', []))
    };
}

function normalizeProfiles(raw: unknown): Record<string, SyncProfile> {
    const profiles: Record<string, SyncProfile> = {};
    if (!raw || typeof raw !== 'object') {
        return profiles;
    }

    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const trimmedKey = (key || '').trim();
        if (!trimmedKey) {
            continue;
        }

        // Legacy format support: { "<gistId>": "<profileName>" }
        if (typeof value === 'string') {
            const profileName = (value || '').trim() || trimmedKey;
            profiles[profileName] = {
                gistId: trimmedKey,
                ignoredSettings: [],
                ignoredExtensions: []
            };
            continue;
        }

        if (!value || typeof value !== 'object') {
            continue;
        }

        const profile = value as {
            gistId?: unknown;
            ignoredSettings?: unknown;
            ignoredExtensions?: unknown;
        };

        profiles[trimmedKey] = {
            gistId: typeof profile.gistId === 'string' ? profile.gistId.trim() : '',
            ignoredSettings: normalizeIgnoredSettings(Array.isArray(profile.ignoredSettings) ? profile.ignoredSettings as string[] : []),
            ignoredExtensions: normalizeExtensionIds(Array.isArray(profile.ignoredExtensions) ? profile.ignoredExtensions as string[] : [])
        };
    }

    return profiles;
}

async function saveCurrentProfileFromGlobal(config?: vscode.WorkspaceConfiguration): Promise<void> {
    const cfg = config || vscode.workspace.getConfiguration('soloboisSettingsSync');
    const profileName = getCurrentProfileName(cfg);
    const profiles = normalizeProfiles(cfg.get<Record<string, unknown>>('profiles', {}));
    profiles[profileName] = getCurrentGlobalSyncState(cfg);
    await cfg.update('profiles', profiles, vscode.ConfigurationTarget.Global);
}

async function applyProfileToGlobalSettings(profileName: string, config?: vscode.WorkspaceConfiguration): Promise<void> {
    const cfg = config || vscode.workspace.getConfiguration('soloboisSettingsSync');
    const profiles = normalizeProfiles(cfg.get<Record<string, unknown>>('profiles', {}));
    const profile = profiles[profileName];
    if (!profile) {
        return;
    }

    await cfg.update('gistId', profile.gistId, vscode.ConfigurationTarget.Global);
    await cfg.update('ignoredSettings', profile.ignoredSettings, vscode.ConfigurationTarget.Global);
    await cfg.update('ignoredExtensions', profile.ignoredExtensions, vscode.ConfigurationTarget.Global);
}

async function initializeProfiles(): Promise<void> {
    const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
    const currentProfile = getCurrentProfileName(config);
    const profiles = normalizeProfiles(config.get<Record<string, unknown>>('profiles', {}));

    if (!profiles[currentProfile]) {
        profiles[currentProfile] = getCurrentGlobalSyncState(config);
    }

    await config.update('profiles', profiles, vscode.ConfigurationTarget.Global);
    await config.update('currentProfile', currentProfile, vscode.ConfigurationTarget.Global);
    await applyProfileToGlobalSettings(currentProfile, config);
}

function getInstalledUserExtensionIds(): Set<string> {
    return new Set(
        vscode.extensions.all
            .filter(ext => !ext.packageJSON?.isBuiltin)
            .map(ext => ext.id.toLowerCase())
    );
}

async function cleanupIgnoredExtensions(): Promise<void> {
    const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
    const current = config.get<string[]>('ignoredExtensions', []);
    const normalized = normalizeExtensionIds(current);
    const installed = getInstalledUserExtensionIds();
    const cleaned = normalized.filter(id => installed.has(id));

    if (JSON.stringify(current) !== JSON.stringify(cleaned)) {
        await config.update('ignoredExtensions', cleaned, vscode.ConfigurationTarget.Global);
        await saveCurrentProfileFromGlobal(config);
    }
}

type SyncOptions = {
    syncSettings: boolean;
    syncExtensions: boolean;
    syncKeybindings: boolean;
    syncSnippets: boolean;
    syncAntigravityConfig: boolean;
};

function isAntigravityPlatform(platform: Platform): boolean {
    return platform === 'antigravity';
}

function getSyncOptions(config?: vscode.WorkspaceConfiguration): SyncOptions {
    const cfg = config || vscode.workspace.getConfiguration('soloboisSettingsSync');
    const inferredDefault = isAntigravityPlatform(currentPlatform);
    const inspected = cfg.inspect<boolean>('syncAntigravityConfig');
    const hasUserValue =
        inspected?.globalValue !== undefined ||
        inspected?.workspaceValue !== undefined ||
        inspected?.workspaceFolderValue !== undefined;

    const syncAntigravityConfig = hasUserValue
        ? cfg.get<boolean>('syncAntigravityConfig', inferredDefault)
        : inferredDefault;

    return {
        syncSettings: cfg.get<boolean>('syncSettings', true),
        syncExtensions: cfg.get<boolean>('syncExtensions', true),
        syncKeybindings: cfg.get<boolean>('syncKeybindings', true),
        syncSnippets: cfg.get<boolean>('syncSnippets', true),
        syncAntigravityConfig
    };
}

function parseJsonc(content: string): any | null {
    try {
        let isInsideString = false;
        let isInsideSingleLineComment = false;
        let isInsideMultiLineComment = false;
        let cleaned = '';

        for (let i = 0; i < content.length; i++) {
            const char = content[i];
            const nextChar = content[i + 1];

            if (isInsideSingleLineComment) {
                if (char === '\n') {
                    isInsideSingleLineComment = false;
                    cleaned += char;
                }
                continue;
            }

            if (isInsideMultiLineComment) {
                if (char === '*' && nextChar === '/') {
                    isInsideMultiLineComment = false;
                    i++;
                }
                continue;
            }

            if (isInsideString) {
                cleaned += char;
                if (char === '"' && content[i - 1] !== '\\') {
                    isInsideString = false;
                }
                continue;
            }

            if (char === '"') {
                isInsideString = true;
                cleaned += char;
                continue;
            }

            if (char === '/' && nextChar === '/') {
                isInsideSingleLineComment = true;
                i++;
                continue;
            }

            if (char === '/' && nextChar === '*') {
                isInsideMultiLineComment = true;
                i++;
                continue;
            }

            cleaned += char;
        }

        return JSON.parse(cleaned.replace(/,\s*([\]}])/g, '$1'));
    } catch {
        return null;
    }
}

function filterSettingsByPlatform(settingsText: string, platform: Platform): { content: string; skippedKeys: string[] } {
    if (isAntigravityPlatform(platform)) {
        return { content: settingsText, skippedKeys: [] };
    }

    const parsed = parseJsonc(settingsText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { content: settingsText, skippedKeys: [] };
    }

    const obj = { ...(parsed as Record<string, unknown>) };
    const skippedKeys = Object.keys(obj).filter(key => key.toLowerCase().startsWith('antigravity.'));
    for (const key of skippedKeys) {
        delete obj[key];
    }

    return {
        content: JSON.stringify(obj, null, 4),
        skippedKeys
    };
}

async function filterExtensionsByMarketplace(
    extensionsJson: string
): Promise<{ filteredJson: string; unavailableIds: string[]; unknownIds: string[] }> {
    let remoteList: Array<{ id?: string; [k: string]: any }>;
    try {
        remoteList = JSON.parse(extensionsJson);
    } catch {
        return { filteredJson: extensionsJson, unavailableIds: [], unknownIds: [] };
    }

    const ids = remoteList
        .map(ext => (ext.id || '').trim().toLowerCase())
        .filter(id => !!id);
    const availability = await checkMarketplaceForPlatform(ids, currentPlatform);

    const unavailableIds: string[] = [];
    const unknownIds: string[] = [];
    const filtered = remoteList.filter(ext => {
        const id = (ext.id || '').trim().toLowerCase();
        if (!id) {
            return true;
        }
        const state: ExtensionAvailability = availability.get(id) ?? 'unknown';
        if (state === 'unavailable') {
            unavailableIds.push(id);
            return false;
        }
        if (state === 'unknown') {
            unknownIds.push(id);
        }
        return true;
    });

    return {
        filteredJson: JSON.stringify(filtered, null, 2),
        unavailableIds,
        unknownIds
    };
}

// ??? Activation ??????????????????????????????????????????????????????

export async function activate(context: vscode.ExtensionContext) {
    console.log('Soloboi\'s Settings Sync is now active.');

    // Initialize Services
    authManager = new AuthManager(context);
    gistService = new GistService();
    settingsManager = new SettingsManager();
    currentPlatform = detectPlatform();
    console.log(`Soloboi's Settings Sync: detected platform = ${currentPlatform} (appName: ${vscode.env.appName})`);
    await initializeProfiles();

    // Initialize UI
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'soloboisSettingsSync.syncNow';
    context.subscriptions.push(statusBarItem);
    updateStatusBar('idle');
    statusBarItem.show();

    // Create Output Channel for Diff View
    outputChannel = vscode.window.createOutputChannel('Soloboi\'s Settings Sync Log');
    context.subscriptions.push(outputChannel);

    // Register Tree View
    const treeProvider = new SoloboiSyncTreeProvider(authManager, gistService);
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('soloboisSettingsSync.treeView', treeProvider)
    );

    // Keep ignoredExtensions clean when extensions are removed.
    await cleanupIgnoredExtensions();
    context.subscriptions.push(
        vscode.extensions.onDidChange(() => {
            void cleanupIgnoredExtensions();
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (event) => {
            const profileChanged = event.affectsConfiguration('soloboisSettingsSync.currentProfile');
            const managedValueChanged =
                event.affectsConfiguration('soloboisSettingsSync.gistId') ||
                event.affectsConfiguration('soloboisSettingsSync.ignoredSettings') ||
                event.affectsConfiguration('soloboisSettingsSync.ignoredExtensions');

            if (profileChanged) {
                const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
                const profileName = getCurrentProfileName(config);
                await applyProfileToGlobalSettings(profileName, config);
                await cleanupIgnoredExtensions();
                await saveCurrentProfileFromGlobal(config);
                treeProvider.refresh();
                return;
            }

            if (managedValueChanged) {
                await saveCurrentProfileFromGlobal();
                treeProvider.refresh();
            }
        })
    );

    // ?? Register Commands ????????????????????????????????????????????

    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.login', async () => {
            await authManager.login();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.logout', async () => {
            await authManager.logout();
            updateStatusBar('logged-out');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.uploadNow', async () => {
            await ensureLoggedIn();
            await uploadSettings(context);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.downloadNow', async () => {
            await ensureLoggedIn();
            await downloadSettings(context);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.syncNow', async () => {
            await ensureLoggedIn();
            await fullSync(context);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.showHistory', async () => {
            await ensureLoggedIn();
            await showGistHistory(context);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.switchProfile', async () => {
            await switchProfile(treeProvider);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.setGistId', async () => {
            const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
            const currentId = config.get<string>('gistId') || '';
            const input = await vscode.window.showInputBox({
                title: 'Set Gist ID',
                prompt: 'Enter the GitHub Gist ID used for sync.',
                value: currentId,
                placeHolder: 'e.g. abc123def456...',
                validateInput: (value) => {
                    if (value && !/^[a-f0-9]+$/i.test(value)) {
                        return 'Gist ID must be a hexadecimal string.';
                    }
                    return null;
                }
            });
            if (input !== undefined) {
                await config.update('gistId', input, vscode.ConfigurationTarget.Global);
                await saveCurrentProfileFromGlobal(config);
                if (input) {
                    vscode.window.showInformationMessage(`Soloboi's Settings Sync: Gist ID updated. (${input.substring(0, 8)}...)`);
                } else {
                    vscode.window.showInformationMessage("Soloboi's Settings Sync: Gist ID cleared.");
                }
                treeProvider.refresh();
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.selectGist', async (gistId: string) => {
            const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
            await config.update('gistId', gistId, vscode.ConfigurationTarget.Global);
            await saveCurrentProfileFromGlobal(config);
            vscode.window.showInformationMessage(`Soloboi's Settings Sync: Gist ID updated. (${gistId.substring(0, 8)}...)`);
            treeProvider.refresh();
        })
    );

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
        })
    );

    context.subscriptions.push(
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
        })
    );

    // ?? Setup Wizard ?????????????????????????????????????????????????

    const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
    const gistId = config.get<string>('gistId');
    const prompted = context.globalState.get<boolean>('setupPrompted', false);

    if (!gistId && !prompted) {
        // Welcome Wizard Prompt
        vscode.window.showInformationMessage(
            'Welcome to Soloboi\'s Settings Sync. Start setup to download from an existing Gist, or skip for now.',
            'Start Setup', 'Skip'
        ).then(async (selection) => {
            if (selection === 'Start Setup') {
                context.globalState.update('setupPrompted', true);
                vscode.commands.executeCommand('soloboisSettingsSync.downloadNow');
            } else if (selection === 'Skip') {
                context.globalState.update('setupPrompted', true);
            }
        });
    }

    // ?? Startup Auto-Sync ????????????????????????????????????????????

    if (config.get<boolean>('autoSyncOnStartup')) {
        // Delay slightly to let VS Code finish initialising
        setTimeout(async () => {
            const session = await authManager.getSessionSilent();
            if (session) {
                await downloadSettings(context, true);
            }
        }, 3000);
    }

    // ?? File Watchers (auto-upload on change) ????????????????????????

    setupFileWatchers(context);
}

// ??? Deactivation ????????????????????????????????????????????????????

export function deactivate(): Thenable<void> | undefined {
    // Upload current settings on exit
    if (authManager?.isLoggedIn()) {
        // We can't fully await here, but we return the promise so VS Code waits
        return (async () => {
            try {
                const token = await authManager.getToken();
                if (!token) { return; }
                const files = buildGistFiles();
                if (!files) { return; }

                const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
                const gistId = config.get<string>('gistId');
                if (gistId) {
                    await gistService.updateGist(gistId, files, token);
                    console.log('Soloboi\'s Settings Sync: Uploaded settings on exit.');
                }
            } catch (err) {
                console.error('Soloboi\'s Settings Sync: Failed to upload on exit', err);
            }
        })();
    }
    return undefined;
}

// ??? Upload Settings ?????????????????????????????????????????????????

async function uploadSettings(
    context: vscode.ExtensionContext,
    silent: boolean = false
): Promise<void> {
    if (isUploading) { return; }
    isUploading = true;
    updateStatusBar('uploading');

    try {
        const token = await authManager.getToken();
        if (!token) {
            if (!silent) {
                vscode.window.showWarningMessage("Soloboi's Settings Sync: Please log in to GitHub first.");
            }
            return;
        }

        const files = buildGistFiles();
        if (!files) {
            if (!silent) {
                vscode.window.showErrorMessage("Soloboi's Settings Sync: No sync files were generated.");
            }
            return;
        }

        const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
        let gistId = config.get<string>('gistId');

        if (!gistId) {
            const newId = await selectOrCreateGist(context, token, files, silent);
            if (!newId) return;
            gistId = newId;
        }

        const dateStr = new Date().toLocaleString();
        const hostname = os.hostname();
        const description = `${GIST_DESCRIPTION_PREFIX}${hostname} (${dateStr})`;

        await gistService.updateGist(gistId, files, token, description);
        if (!silent) {
            vscode.window.showInformationMessage("Soloboi's Settings Sync: Uploaded to Gist.");
        }

        const now = new Date().toISOString();
        context.globalState.update(LAST_SYNC_KEY, now);
        lastSyncTime = now;
        updateStatusBar('idle');

    } catch (err: any) {
        console.error("Soloboi's Settings Sync upload error:", err);
        if (!silent) {
            vscode.window.showErrorMessage(`Soloboi's Settings Sync: Upload failed: ${err.message}`);
        }
        updateStatusBar('error');
    } finally {
        isUploading = false;
    }
}

// ??? Download Settings ???????????????????????????????????????????????

async function downloadSettings(
    context: vscode.ExtensionContext,
    silent: boolean = false,
    forceOmissionNotice: boolean = false
): Promise<boolean> {
    if (isDownloading) {
        return false;
    }
    isDownloading = true;
    updateStatusBar('downloading');

    try {
        const token = await authManager.getToken();
        if (!token) {
            if (!silent) {
                vscode.window.showWarningMessage("Soloboi's Settings Sync: Please log in to GitHub first.");
            }
            return false;
        }

        const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
        let gistId = config.get<string>('gistId');

        if (!gistId) {
            if (silent) {
                return false;
            }

            const files = buildGistFiles();
            const newId = await selectOrCreateGist(context, token, files, silent);
            if (!newId) {
                return false;
            }
            gistId = newId;
        }

        const gistData = await gistService.getGist(gistId, token);
        if (!gistData?.files) {
            throw new Error('Invalid Gist data');
        }

        await applyGistData(gistData, context, silent, forceOmissionNotice);
        return true;

    } catch (err: any) {
        console.error("Soloboi's Settings Sync download error:", err);
        if (!silent) {
            vscode.window.showErrorMessage(`Soloboi's Settings Sync: Download failed: ${err.message}`);
        }
        updateStatusBar('error');
        return false;
    } finally {
        isDownloading = false;
    }
}

// ??? Full Sync (Download then Upload) ????????????????????????????????

async function fullSync(context: vscode.ExtensionContext): Promise<void> {
    const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
    const gistId = config.get<string>('gistId');

    if (gistId) {
        const downloaded = await downloadSettings(context, true, true);
        if (!downloaded) {
            vscode.window.showWarningMessage(
                "Soloboi's Settings Sync: Download step failed. Upload skipped to avoid overwriting remote settings."
            );
            return;
        }
        await uploadSettings(context, false);
        vscode.window.showInformationMessage("Soloboi's Settings Sync: Sync complete!");
    } else {
        await uploadSettings(context, false);
    }
}

// ??? File Watchers ???????????????????????????????????????????????????

function setupFileWatchers(context: vscode.ExtensionContext): void {
    const settingsDir = settingsManager.getUserSettingsDir();
    if (!settingsDir) { return; }

    const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
    if (!config.get<boolean>('autoUploadOnChange', true)) { return; }

    const delay = config.get<number>('autoUploadDelay', 5000);

    // Watch settings.json and keybindings.json
    const pattern = new vscode.RelativePattern(
        vscode.Uri.file(settingsDir),
        '{settings.json,keybindings.json}'
    );

    fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

    // Watch snippets directory
    const snippetsDir = settingsManager.getSnippetsDir();
    let snippetsWatcher: vscode.FileSystemWatcher | undefined;
    if (snippetsDir) {
        const snippetsPattern = new vscode.RelativePattern(
            vscode.Uri.file(snippetsDir),
            '{*.json,*.code-snippets}'
        );
        snippetsWatcher = vscode.workspace.createFileSystemWatcher(snippetsPattern);
    }

    // Watch Antigravity internal settings (mcp_config.json, browserAllowlist.txt)
    const antigravityDataDir = settingsManager.getAntigravityDataDir();
    let antigravityWatcher: vscode.FileSystemWatcher | undefined;
    if (antigravityDataDir) {
        const antiPattern = new vscode.RelativePattern(
            vscode.Uri.file(antigravityDataDir),
            '{mcp_config.json,browserAllowlist.txt}'
        );
        antigravityWatcher = vscode.workspace.createFileSystemWatcher(antiPattern);
    }

    const scheduleUpload = () => {
        if (uploadTimer) {
            clearTimeout(uploadTimer);
        }
        uploadTimer = setTimeout(async () => {
            const session = await authManager.getSessionSilent();
            if (session) {
                await uploadSettings(context, true);
            }
        }, delay);
    };

    fileWatcher.onDidChange(scheduleUpload);
    fileWatcher.onDidCreate(scheduleUpload);

    context.subscriptions.push(fileWatcher);

    if (snippetsWatcher) {
        snippetsWatcher.onDidChange(scheduleUpload);
        snippetsWatcher.onDidCreate(scheduleUpload);
        snippetsWatcher.onDidDelete(scheduleUpload);
        context.subscriptions.push(snippetsWatcher);
    }

    if (antigravityWatcher) {
        antigravityWatcher.onDidChange(scheduleUpload);
        antigravityWatcher.onDidCreate(scheduleUpload);
        context.subscriptions.push(antigravityWatcher);
    }
}

// ??? Apply Gist Data ?????????????????????????????????????????????????

// ?? Diff Helpers ???????????????????????????????????????????????????

function generateSettingsDiff(oldText: string | null, newText: string): string[] {
    const diffs: string[] = [];
    if (!oldText) return ['+ (local file missing, full write)'];
    try {
        const stripJsonc = (str: string) => {
            let isInsideString = false;
            let isInsideSingleLineComment = false;
            let isInsideMultiLineComment = false;
            let cleaned = '';
            for (let i = 0; i < str.length; i++) {
                const char = str[i];
                const nextChar = str[i + 1];
                if (isInsideSingleLineComment) {
                    if (char === '\n') { isInsideSingleLineComment = false; cleaned += char; }
                    continue;
                }
                if (isInsideMultiLineComment) {
                    if (char === '*' && nextChar === '/') { isInsideMultiLineComment = false; i++; }
                    continue;
                }
                if (isInsideString) {
                    cleaned += char;
                    if (char === '"' && str[i - 1] !== '\\') isInsideString = false;
                    continue;
                }
                if (char === '"') { isInsideString = true; cleaned += char; continue; }
                if (char === '/' && nextChar === '/') { isInsideSingleLineComment = true; i++; continue; }
                if (char === '/' && nextChar === '*') { isInsideMultiLineComment = true; i++; continue; }
                cleaned += char;
            }
            return cleaned.replace(/,\s*([\]}])/g, '$1');
        };
        const oldObj = JSON.parse(stripJsonc(oldText)) || {};
        const newObj = JSON.parse(stripJsonc(newText)) || {};

        for (const key of Object.keys(newObj)) {
            if (!(key in oldObj)) {
                diffs.push(`+ added: ${key} (${JSON.stringify(newObj[key])})`);
            } else if (JSON.stringify(oldObj[key]) !== JSON.stringify(newObj[key])) {
                diffs.push(`~ changed: ${key} (${JSON.stringify(oldObj[key])} -> ${JSON.stringify(newObj[key])})`);
            }
        }
        for (const key of Object.keys(oldObj)) {
            if (!(key in newObj)) diffs.push(`- removed: ${key}`);
        }
    } catch (e) {
        if (oldText.trim() !== newText.trim()) diffs.push('~ text changed');
    }
    return diffs;
}

function generateExtensionsDiff(oldListStr: string | null, newListStr: string): string[] {
    const diffs: string[] = [];
    try {
        const oldList = oldListStr ? JSON.parse(oldListStr) : [];
        const newList = JSON.parse(newListStr);
        const oldIds = new Set(oldList.map((e: any) => e.id));
        const newIds = new Set(newList.map((e: any) => e.id));

        for (const ext of newList) {
            if (!oldIds.has(ext.id)) diffs.push(`+ install target: ${ext.name || ext.id}`);
        }
        for (const ext of oldList) {
            if (!newIds.has(ext.id)) diffs.push(`- remove target: ${ext.name || ext.id}`);
        }
    } catch (e) { }
    return diffs;
}

// ?? Apply Gist Data ??????????????????????????????????????????????

type RemoteExtensionEntry = {
    id: string;
    name?: string;
};

function parseExtensionList(content: string): RemoteExtensionEntry[] {
    try {
        const parsed = JSON.parse(content);
        if (!Array.isArray(parsed)) {
            return [];
        }

        return parsed
            .filter(item => item && typeof item === 'object' && typeof item.id === 'string')
            .map(item => ({
                id: item.id.trim(),
                name: typeof item.name === 'string' ? item.name.trim() : undefined
            }))
            .filter(item => !!item.id);
    } catch {
        return [];
    }
}

function extensionLabel(entry: RemoteExtensionEntry): string {
    const id = entry.id.trim();
    const name = (entry.name || '').trim();
    if (!name || name.toLowerCase() === id.toLowerCase()) {
        return id;
    }
    return `${name} (${id})`;
}

function hasContentChanged(oldContent: string | null, newContent: string): boolean {
    const before = (oldContent || '').trim();
    const after = (newContent || '').trim();
    return before !== after;
}

function uniqueList(values: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
        if (!value || seen.has(value)) {
            continue;
        }
        seen.add(value);
        result.push(value);
    }
    return result;
}

async function applyGistData(
    gistData: any,
    context: vscode.ExtensionContext,
    silent: boolean = false,
    forceOmissionNotice: boolean = false
): Promise<void> {
    settingsManager.backupCurrentSettings();
    outputChannel.clear();
    outputChannel.appendLine('=== Soloboi\'s Settings Sync download report ===');
    outputChannel.appendLine('');

    const fileMap = (gistData?.files || {}) as Record<string, { content?: string }>;
    const syncOptions = getSyncOptions();
    const antigravityMode = isAntigravityPlatform(currentPlatform);
    const ignoredExtensionIds = new Set(
        normalizeExtensionIds(
            vscode.workspace.getConfiguration('soloboisSettingsSync').get<string[]>('ignoredExtensions', [])
        )
    );

    outputChannel.appendLine(`[Platform] ${currentPlatform}`);
    outputChannel.appendLine(
        antigravityMode
            ? '  - Native mode (no platform filtering).'
            : '  - Cross-platform mode (antigravity.* settings and Antigravity-only files are filtered).'
    );
    outputChannel.appendLine('');

    let hasChanges = false;
    let installedCount = 0;
    let uninstalledCount = 0;
    const omissionSummary: OmissionSummary = {
        skippedSettingKeys: [],
        skippedAntigravityFiles: []
    };

    if (fileMap['settings.json']) {
        outputChannel.appendLine('[Settings.json]');
        if (!syncOptions.syncSettings) {
            outputChannel.appendLine('  ! skipped by syncSettings=false');
        } else {
            const remoteSettings = fileMap['settings.json'].content || '{}';
            const filtered = filterSettingsByPlatform(remoteSettings, currentPlatform);
            const oldText = settingsManager.readLocalSettings();
            const diffs = generateSettingsDiff(oldText, filtered.content);

            if (diffs.length > 0) {
                for (const diff of diffs) {
                    outputChannel.appendLine(`  ${diff}`);
                }
                hasChanges = true;
            } else {
                outputChannel.appendLine('  - no detected key changes');
            }

            for (const skippedKey of filtered.skippedKeys) {
                outputChannel.appendLine(`  ! skipped (platform mismatch): ${skippedKey}`);
            }

            if (filtered.skippedKeys.length > 0) {
                omissionSummary.skippedSettingKeys.push(...filtered.skippedKeys);
            }

            if (hasContentChanged(oldText, filtered.content)) {
                hasChanges = true;
            }

            settingsManager.writeLocalSettings(filtered.content);
        }
        outputChannel.appendLine('');
    }

    if (fileMap['keybindings.json']) {
        outputChannel.appendLine('[Keybindings]');
        if (!syncOptions.syncKeybindings) {
            outputChannel.appendLine('  ! skipped by syncKeybindings=false');
        } else {
            const remoteKeybindings = fileMap['keybindings.json'].content || '[]';
            const before = settingsManager.readLocalKeybindings();
            if (hasContentChanged(before, remoteKeybindings)) {
                hasChanges = true;
            }
            settingsManager.writeLocalKeybindings(remoteKeybindings);
            outputChannel.appendLine('  + applied keybindings.json');
        }
        outputChannel.appendLine('');
    }

    if (fileMap['snippets.json']) {
        outputChannel.appendLine('[Snippets]');
        if (!syncOptions.syncSnippets) {
            outputChannel.appendLine('  ! skipped by syncSnippets=false');
        } else {
            const remoteSnippets = fileMap['snippets.json'].content || '{}';
            const before = settingsManager.readSnippets();
            if (hasContentChanged(before, remoteSnippets)) {
                hasChanges = true;
            }
            settingsManager.writeSnippets(remoteSnippets);
            outputChannel.appendLine('  + applied snippets');
        }
        outputChannel.appendLine('');
    }

    const antigravityFileLines: string[] = [];
    if (fileMap['antigravity.json']) {
        if (!syncOptions.syncAntigravityConfig) {
            antigravityFileLines.push('  ! skipped: antigravity.json (syncAntigravityConfig=false)');
        } else if (!antigravityMode) {
            antigravityFileLines.push('  ! skipped: antigravity.json (platform mismatch)');
            omissionSummary.skippedAntigravityFiles.push('antigravity.json');
        } else {
            const remoteConfig = fileMap['antigravity.json'].content || '{}';
            const before = settingsManager.readAntigravityConfig();
            if (hasContentChanged(before, remoteConfig)) {
                hasChanges = true;
            }
            settingsManager.writeAntigravityConfig(remoteConfig);
            antigravityFileLines.push('  + applied: antigravity.json');
        }
    }

    if (fileMap['browserAllowlist.txt']) {
        if (!syncOptions.syncAntigravityConfig) {
            antigravityFileLines.push('  ! skipped: browserAllowlist.txt (syncAntigravityConfig=false)');
        } else if (!antigravityMode) {
            antigravityFileLines.push('  ! skipped: browserAllowlist.txt (platform mismatch)');
            omissionSummary.skippedAntigravityFiles.push('browserAllowlist.txt');
        } else {
            const remoteAllowlist = fileMap['browserAllowlist.txt'].content || '';
            const before = settingsManager.readBrowserAllowlist();
            if (hasContentChanged(before, remoteAllowlist)) {
                hasChanges = true;
            }
            settingsManager.writeBrowserAllowlist(remoteAllowlist);
            antigravityFileLines.push('  + applied: browserAllowlist.txt');
        }
    }

    if (antigravityFileLines.length > 0) {
        outputChannel.appendLine('[Antigravity-only files]');
        for (const line of antigravityFileLines) {
            outputChannel.appendLine(line);
        }
        outputChannel.appendLine('');
    }

    if (fileMap['extensions.json']) {
        outputChannel.appendLine('[Extensions]');
        if (!syncOptions.syncExtensions) {
            outputChannel.appendLine('  ! skipped by syncExtensions=false');
            outputChannel.appendLine('');
        } else {
            const remoteExtensions = fileMap['extensions.json'].content || '[]';
            const oldText = settingsManager.readInstalledExtensions();
            const originalEntries = parseExtensionList(remoteExtensions);
            const displayById = new Map<string, string>(
                originalEntries.map(entry => [entry.id.toLowerCase(), extensionLabel(entry)])
            );

            const {
                filteredJson,
                unavailableIds,
                unknownIds
            } = await filterExtensionsByMarketplace(remoteExtensions);

            const filteredEntries = parseExtensionList(filteredJson);
            const currentlyInstalled = getInstalledUserExtensionIds();
            const installedNames: string[] = [];
            const alreadyInstalledNames: string[] = [];
            const skippedIgnoredNames: string[] = [];
            const failedInstallNames: string[] = [];

            for (const entry of filteredEntries) {
                const normalizedId = entry.id.toLowerCase();
                const label = extensionLabel(entry);

                if (ignoredExtensionIds.has(normalizedId)) {
                    skippedIgnoredNames.push(label);
                    continue;
                }

                if (currentlyInstalled.has(normalizedId)) {
                    alreadyInstalledNames.push(label);
                    continue;
                }

                try {
                    await vscode.commands.executeCommand(
                        'workbench.extensions.installExtension',
                        entry.id
                    );
                    installedCount++;
                    installedNames.push(label);
                    currentlyInstalled.add(normalizedId);
                } catch (err: any) {
                    const reason = err?.message ? `: ${err.message}` : '';
                    failedInstallNames.push(`${label}${reason}`);
                }
            }

            uninstalledCount = await settingsManager.uninstallExtraExtensions(filteredJson);

            const extDiffs = generateExtensionsDiff(oldText, filteredJson);
            if (extDiffs.length > 0) {
                for (const diff of extDiffs) {
                    outputChannel.appendLine(`  ${diff}`);
                }
            }

            const uniqueUnavailable = uniqueList(unavailableIds);
            for (const id of uniqueUnavailable) {
                const label = displayById.get(id) || id;
                outputChannel.appendLine(`  ! skipped (not found in marketplace): ${label}`);
            }

            const uniqueUnknown = uniqueList(unknownIds);
            for (const id of uniqueUnknown) {
                const label = displayById.get(id) || id;
                outputChannel.appendLine(`  ! marketplace check unknown (install attempted): ${label}`);
            }

            for (const name of installedNames) {
                outputChannel.appendLine(`  + installed: ${name}`);
            }
            for (const name of alreadyInstalledNames) {
                outputChannel.appendLine(`  = already installed: ${name}`);
            }
            for (const name of skippedIgnoredNames) {
                outputChannel.appendLine(`  ! skipped (ignored): ${name}`);
            }
            for (const name of failedInstallNames) {
                outputChannel.appendLine(`  ! install failed: ${name}`);
            }

            if (uninstalledCount > 0) {
                outputChannel.appendLine(`  - removed extra extensions: ${uninstalledCount}`);
            }

            if (
                extDiffs.length === 0 &&
                uniqueUnavailable.length === 0 &&
                uniqueUnknown.length === 0 &&
                installedNames.length === 0 &&
                alreadyInstalledNames.length === 0 &&
                skippedIgnoredNames.length === 0 &&
                failedInstallNames.length === 0 &&
                uninstalledCount === 0
            ) {
                outputChannel.appendLine('  - no extension updates');
            }

            if (
                extDiffs.length > 0 ||
                installedNames.length > 0 ||
                failedInstallNames.length > 0 ||
                uninstalledCount > 0
            ) {
                hasChanges = true;
            }

            outputChannel.appendLine('');
        }
    }

    if (!hasChanges) {
        outputChannel.appendLine('No local changes were applied.');
    }

    const now = new Date().toISOString();
    context.globalState.update(LAST_SYNC_KEY, now);
    lastSyncTime = now;
    updateStatusBar('idle');

    const uniqueSkippedKeys = uniqueList(omissionSummary.skippedSettingKeys);
    const uniqueSkippedFiles = uniqueList(omissionSummary.skippedAntigravityFiles);
    const hasOmissions = uniqueSkippedKeys.length > 0 || uniqueSkippedFiles.length > 0;

    if (hasOmissions) {
        outputChannel.appendLine('[Cross-platform note] 일부 설정값이 플랫폼 차이로 누락되었습니다.');
        outputChannel.appendLine('  - Antigravity는 VS Code 기반이지만, Antigravity 전용 설정값은 VS Code에서 직접 적용이 어려울 수 있습니다.');
        outputChannel.appendLine('  - 일부 설정값은 사용자가 직접 수정해야 합니다.');
        if (uniqueSkippedKeys.length > 0) {
            outputChannel.appendLine(`  - skipped antigravity.* keys: ${uniqueSkippedKeys.length}`);
        }
        if (uniqueSkippedFiles.length > 0) {
            outputChannel.appendLine(`  - skipped Antigravity-only files: ${uniqueSkippedFiles.join(', ')}`);
        }
        outputChannel.appendLine('');
    }

    if (!silent) {
        let msg = 'Soloboi\'s Settings Sync complete: settings applied.';
        if (installedCount > 0 || uninstalledCount > 0) {
            msg += ` (extensions +${installedCount}, -${uninstalledCount})`;
        }

        vscode.window.showInformationMessage(msg, 'View report').then(selection => {
            if (selection === 'View report') {
                outputChannel.show(true);
            }
        });
    }

    if (hasOmissions && (!silent || forceOmissionNotice)) {
        const parts: string[] = [];
        if (uniqueSkippedKeys.length > 0) {
            parts.push(`antigravity.* 설정 ${uniqueSkippedKeys.length}개`);
        }
        if (uniqueSkippedFiles.length > 0) {
            parts.push(`Antigravity 전용 파일 ${uniqueSkippedFiles.length}개`);
        }

        const summary = parts.length > 0 ? parts.join(', ') : '일부 설정';
        vscode.window.showWarningMessage(
            `일부 설정값이 누락될 수 있습니다. (${summary}) 누락된 설정은 동기화 이후 사용자에게 안내됩니다.`,
            'View report'
        ).then(selection => {
            if (selection === 'View report') {
                outputChannel.show(true);
            }
        });
    }
}
async function showGistHistory(context: vscode.ExtensionContext): Promise<void> {
    const token = await authManager.getToken();
    if (!token) return;

    const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
    const gistId = config.get<string>('gistId');
    if (!gistId) {
        vscode.window.showWarningMessage("Soloboi's Settings Sync: Gist ID is not set.");
        return;
    }

    updateStatusBar('downloading');
    try {
        const history = await gistService.getGistHistory(gistId, token);
        if (!history || history.length === 0) {
            vscode.window.showInformationMessage("Soloboi's Settings Sync: No Gist history found.");
            updateStatusBar('idle');
            return;
        }

        const items: vscode.QuickPickItem[] = history.map((h: any) => ({
            label: `$(git-commit) ${new Date(h.committed_at).toLocaleString()}`,
            description: h.version.substring(0, 7),
            detail: `Additions: ${h.change_status?.additions || 0}, Deletions: ${h.change_status?.deletions || 0}`,
            version: h.version
        }));

        updateStatusBar('idle');
        const selected = await vscode.window.showQuickPick(items, {
            title: 'Select a Gist revision to restore',
            placeHolder: 'Choose a previous settings version'
        });

        if (selected) {
            const sha = (selected as any).version;
            updateStatusBar('downloading');
            const gistData = await gistService.getGistRevision(gistId, sha, token);
            await applyGistData(gistData, context);
            updateStatusBar('idle');
            vscode.window.showInformationMessage("Soloboi's Settings Sync: Restored selected revision.");
        }
    } catch (err: any) {
        vscode.window.showErrorMessage(`Soloboi's Settings Sync: Failed to load history: ${err.message}`);
        updateStatusBar('error');
    }
}

// ??? Helpers ?????????????????????????????????????????????????????????

async function switchProfile(treeProvider: SoloboiSyncTreeProvider): Promise<void> {
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
}

async function selectOrCreateGist(
    context: vscode.ExtensionContext,
    token: string,
    files: any,
    silent: boolean
): Promise<string | null> {
    if (silent) return null;

    updateStatusBar('downloading');
    let gists: any[] = [];
    try {
        gists = await gistService.getUserGists(token);
    } catch (err) {
        vscode.window.showErrorMessage("Soloboi's Settings Sync: Failed to fetch Gist list.");
        updateStatusBar('idle');
        return null;
    }

    const platformGists = gists.filter(g =>
        g.description && g.description.startsWith(GIST_DESCRIPTION_PREFIX)
    );

    updateStatusBar('idle');

    if (platformGists.length === 0) {
        return await createNewGist(token, files, silent);
    }

    const items: vscode.QuickPickItem[] = [
        {
            label: '$(add) Create New Sync Gist',
            description: 'Create a new Gist from current local settings.',
            detail: 'NEW'
        },
        {
            label: '',
            kind: vscode.QuickPickItemKind.Separator
        }
    ];

    platformGists.forEach(g => {
        items.push({
            label: `$(repo) ${g.description}`,
            description: g.id,
            detail: `Last updated: ${new Date(g.updated_at).toLocaleString()}`,
            id: g.id
        } as any);
    });

    const selected = await vscode.window.showQuickPick(items, {
        title: 'Select Sync Gist',
        placeHolder: 'Select an existing sync Gist or create a new one.'
    });

    if (!selected) return null;

    const config = vscode.workspace.getConfiguration('soloboisSettingsSync');

    if ((selected as any).detail === 'NEW') {
        const gistId = await createNewGist(token, files, silent);
        if (gistId) {
            await config.update('gistId', gistId, vscode.ConfigurationTarget.Global);
            await saveCurrentProfileFromGlobal(config);
        }
        return gistId;
    }

    const gistId = (selected as any).id;
    await config.update('gistId', gistId, vscode.ConfigurationTarget.Global);
    await saveCurrentProfileFromGlobal(config);
    vscode.window.showInformationMessage(`Soloboi's Settings Sync: Selected existing Gist (${gistId}).`);
    return gistId;
}

async function createNewGist(token: string, files: any, silent: boolean): Promise<string | null> {
    const dateStr = new Date().toLocaleString();
    const hostname = os.hostname();
    const description = `${GIST_DESCRIPTION_PREFIX}${hostname} (${dateStr})`;

    const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
    const isPublic = config.get<boolean>('publicGist', false);

    try {
        updateStatusBar('uploading');
        const result = await gistService.createGist(description, files || buildGistFiles(), token, isPublic);
        updateStatusBar('idle');

        if (!silent) {
            vscode.window.showInformationMessage(
                `Soloboi's Settings Sync: New Gist created. (machine: ${hostname})`
            );
        }
        return result.id;
    } catch (err: any) {
        console.error("Soloboi's Settings Sync: Create Gist error", err);
        if (!silent) {
            vscode.window.showErrorMessage(`Soloboi's Settings Sync: Failed to create Gist: ${err.message}`);
        }
        updateStatusBar('error');
        return null;
    }
}

function buildGistFiles(): Record<string, { content: string }> | null {
    const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
    const syncOptions = getSyncOptions(config);

    const settings = settingsManager.readLocalSettings();
    const keybindings = settingsManager.readLocalKeybindings();
    const extensions = settingsManager.readInstalledExtensions();
    const antigravityConfig = settingsManager.readAntigravityConfig();
    const browserAllowlist = settingsManager.readBrowserAllowlist();
    const snippets = settingsManager.readSnippets();

    const files: Record<string, { content: string }> = {};

    if (syncOptions.syncSettings && settings) {
        const filtered = filterSettingsByPlatform(settings, currentPlatform);
        files['settings.json'] = { content: filtered.content };
    }

    if (syncOptions.syncKeybindings) {
        // keybindings always available (empty array if file doesn't exist)
        files['keybindings.json'] = { content: keybindings };
    }

    if (syncOptions.syncExtensions) {
        // extensions always available (may be empty list)
        files['extensions.json'] = { content: extensions };
    }

    if (syncOptions.syncAntigravityConfig && isAntigravityPlatform(currentPlatform) && antigravityConfig) {
        files['antigravity.json'] = { content: antigravityConfig };
    }
    if (syncOptions.syncAntigravityConfig && isAntigravityPlatform(currentPlatform) && browserAllowlist) {
        files['browserAllowlist.txt'] = { content: browserAllowlist };
    }
    if (syncOptions.syncSnippets && snippets) {
        files['snippets.json'] = { content: snippets };
    }

    if (Object.keys(files).length === 0) {
        return null;
    }
    return files;
}

async function ensureLoggedIn(): Promise<void> {
    const session = await authManager.getSessionSilent();
    if (!session) {
        await authManager.login();
    }
}

function updateStatusBar(state: 'idle' | 'uploading' | 'downloading' | 'error' | 'logged-out') {
    switch (state) {
        case 'uploading':
            statusBarItem.text = '$(sync~spin) Uploading...';
            statusBarItem.tooltip = 'Uploading settings...';
            break;
        case 'downloading':
            statusBarItem.text = '$(sync~spin) Downloading...';
            statusBarItem.tooltip = 'Downloading settings...';
            break;
        case 'error':
            statusBarItem.text = '$(error) Sync Error';
            statusBarItem.tooltip = 'A sync error occurred.';
            setTimeout(() => updateStatusBar('idle'), 5000);
            break;
        case 'logged-out':
            statusBarItem.text = '$(sign-in) Soloboi\'s Settings Sync';
            statusBarItem.tooltip = 'Click to sign in and sync settings.';
            break;
        default: {
            statusBarItem.text = '$(sync) Soloboi\'s Settings Sync';
            const lastSync = lastSyncTime;
            if (lastSync) {
                statusBarItem.tooltip = `Last sync: ${new Date(lastSync).toLocaleString()}\nClick to sync now.`;
            } else {
                statusBarItem.tooltip = 'Click to sync now.';
            }
            break;
        }
    }
}

