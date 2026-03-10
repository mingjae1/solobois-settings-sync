import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { AuthManager } from './auth';
import { GistService } from './gistService';
import { SettingsManager } from './settingsManager';
import { SoloboiSyncTreeProvider } from './treeProvider';

const GIST_DESCRIPTION_PREFIX = 'Soloboi\'s Settings Sync — ';
const GIST_DEFAULT_DESCRIPTION = 'Soloboi\'s Settings Sync — VS Code Settings'; // Used for initial creation
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

// ─── Activation ──────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext) {
    console.log('Soloboi\'s Settings Sync is now active.');

    // Initialize Services
    authManager = new AuthManager(context);
    gistService = new GistService();
    settingsManager = new SettingsManager();
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

    // ── Register Commands ────────────────────────────────────────────

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
                title: 'Gist ID 설정',
                prompt: '동기화에 사용할 GitHub Gist ID를 입력하세요.',
                value: currentId,
                placeHolder: 'e.g. abc123def456...',
                validateInput: (value) => {
                    if (value && !/^[a-f0-9]+$/i.test(value)) {
                        return 'Gist ID는 16진수 문자열이어야 합니다.';
                    }
                    return null;
                }
            });
            if (input !== undefined) {
                await config.update('gistId', input, vscode.ConfigurationTarget.Global);
                await saveCurrentProfileFromGlobal(config);
                if (input) {
                    vscode.window.showInformationMessage(`Soloboi's Settings Sync: Gist ID가 설정되었습니다. (${input.substring(0, 8)}...)`);
                } else {
                    vscode.window.showInformationMessage('Soloboi\'s Settings Sync: Gist ID가 초기화되었습니다.');
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
            vscode.window.showInformationMessage(`Soloboi's Settings Sync: Gist ID가 설정되었습니다. (${gistId.substring(0, 8)}...)`);
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
                placeHolder: '동기화에서 제외할 익스텐션을 선택하세요.',
                title: '익스텐션 동기화 제외 설정'
            });

            if (selected !== undefined) {
                const newIgnored = normalizeExtensionIds(selected.map(item => item.description || ''));
                await config.update('ignoredExtensions', newIgnored, vscode.ConfigurationTarget.Global);
                await saveCurrentProfileFromGlobal(config);
                vscode.window.showInformationMessage('Soloboi\'s Settings Sync: 제외할 익스텐션 목록이 업데이트되었습니다.');
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
                    label: '$(add) 직접 패턴 입력...',
                    description: '직접 제외할 설정 키 또는 와일드카드 패턴(* )을 입력합니다.',
                    alwaysShow: true,
                    isPattern: true
                },
                {
                    label: '현재 설정 및 제외 목록',
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
                placeHolder: '동기화에서 제외할 설정 키를 선택하거나 패턴을 추가하세요.',
                title: '설정 동기화 제외 관리'
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
                        title: '제외 패턴 추가',
                        prompt: '제외할 설정 키 또는 패턴을 입력하세요 (예: terminal.integrated.*)',
                        placeHolder: 'e.g. editor.fontSize'
                    });
                    if (customPattern) {
                        finalIgnored.add(customPattern);
                    }
                }

                await config.update('ignoredSettings', Array.from(finalIgnored), vscode.ConfigurationTarget.Global);
                await saveCurrentProfileFromGlobal(config);
                vscode.window.showInformationMessage('Soloboi\'s Settings Sync: 제외할 설정 목록이 업데이트되었습니다.');
                treeProvider.refresh();
            }
        })
    );

    // ── Setup Wizard ─────────────────────────────────────────────────

    const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
    const gistId = config.get<string>('gistId');
    const prompted = context.globalState.get<boolean>('setupPrompted', false);

    if (!gistId && !prompted) {
        // Welcome Wizard Prompt
        vscode.window.showInformationMessage(
            '🌟 Soloboi\'s Settings Sync에 오신 것을 환영합니다! 기존 기기의 설정을 연동하거나 지금 기기의 설정을 백업해 보세요.',
            '설정 시작하기', '나중에'
        ).then(async (selection) => {
            if (selection === '설정 시작하기') {
                context.globalState.update('setupPrompted', true);
                vscode.commands.executeCommand('soloboisSettingsSync.downloadNow');
            } else if (selection === '나중에') {
                context.globalState.update('setupPrompted', true);
            }
        });
    }

    // ── Startup Auto-Sync ────────────────────────────────────────────

    if (config.get<boolean>('autoSyncOnStartup')) {
        // Delay slightly to let VS Code finish initialising
        setTimeout(async () => {
            const session = await authManager.getSessionSilent();
            if (session) {
                await downloadSettings(context, true);
            }
        }, 3000);
    }

    // ── File Watchers (auto-upload on change) ────────────────────────

    setupFileWatchers(context);
}

// ─── Deactivation ────────────────────────────────────────────────────

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

// ─── Upload Settings ─────────────────────────────────────────────────

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
                vscode.window.showWarningMessage('Soloboi\'s Settings Sync: GitHub에 로그인해주세요.');
            }
            return;
        }

        const files = buildGistFiles();
        if (!files) {
            if (!silent) {
                vscode.window.showErrorMessage('Soloboi\'s Settings Sync: 설정 파일을 읽을 수 없습니다.');
            }
            return;
        }

        const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
        let gistId = config.get<string>('gistId');

        if (!gistId) {
            const newId = await selectOrCreateGist(context, token, files, silent);
            if (!newId) return; // User cancelled or failed
            gistId = newId;
        }

        // Update existing Gist (PATCH)
        const dateStr = new Date().toLocaleString();
        const hostname = os.hostname();
        const description = `${GIST_DESCRIPTION_PREFIX}${hostname} (${dateStr})`;

        await gistService.updateGist(gistId, files, token, description);
        if (!silent) {
            vscode.window.showInformationMessage('Soloboi\'s Settings Sync: 설정이 Gist에 업로드되었습니다.');
        }

        // Store last sync timestamp
        const now = new Date().toISOString();
        context.globalState.update(LAST_SYNC_KEY, now);
        lastSyncTime = now;
        updateStatusBar('idle');

    } catch (err: any) {
        console.error('Soloboi\'s Settings Sync upload error:', err);
        if (!silent) {
            vscode.window.showErrorMessage(`Soloboi\'s Settings Sync: 업로드 실패 — ${err.message}`);
        }
        updateStatusBar('error');
    } finally {
        isUploading = false;
    }
}

// ─── Download Settings ───────────────────────────────────────────────

async function downloadSettings(
    context: vscode.ExtensionContext,
    silent: boolean = false
): Promise<void> {
    updateStatusBar('downloading');

    try {
        const token = await authManager.getToken();
        if (!token) {
            if (!silent) {
                vscode.window.showWarningMessage('Soloboi\'s Settings Sync: GitHub에 로그인해주세요.');
            }
            return;
        }

        const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
        let gistId = config.get<string>('gistId');

        if (!gistId) {
            if (silent) return; // Don't prompt in silent mode on startup if no ID
            
            const files = buildGistFiles();
            const newId = await selectOrCreateGist(context, token, files, silent);
            if (!newId) return; // User cancelled or failed
            gistId = newId;
        }

        const gistData = await gistService.getGist(gistId, token);
        if (!gistData?.files) {
            throw new Error('Invalid Gist data');
        }

        await applyGistData(gistData, context, silent);

    } catch (err: any) {
        console.error('Soloboi\'s Settings Sync download error:', err);
        if (!silent) {
            vscode.window.showErrorMessage(`Soloboi\'s Settings Sync: 다운로드 실패 — ${err.message}`);
        }
        updateStatusBar('error');
    }
}

// ─── Full Sync (Download then Upload) ────────────────────────────────

async function fullSync(context: vscode.ExtensionContext): Promise<void> {
    const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
    const gistId = config.get<string>('gistId');

    if (gistId) {
        // Download first, then upload (so local merges are reflected in Gist)
        await downloadSettings(context, true);
        await uploadSettings(context, false);
        vscode.window.showInformationMessage('Soloboi\'s Settings Sync: 동기화 완료!');
    } else {
        // No Gist yet — just upload to create one
        await uploadSettings(context, false);
    }
}

// ─── File Watchers ───────────────────────────────────────────────────

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

// ─── Apply Gist Data ─────────────────────────────────────────────────

// ── Diff Helpers ───────────────────────────────────────────────────

function generateSettingsDiff(oldText: string | null, newText: string): string[] {
    const diffs: string[] = [];
    if (!oldText) return ['+ (기존 파일 없음, 전체 새로 쓰기)'];
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
                diffs.push(`+ 새로 추가됨: ${key} (${JSON.stringify(newObj[key])})`);
            } else if (JSON.stringify(oldObj[key]) !== JSON.stringify(newObj[key])) {
                diffs.push(`~ 변경됨: ${key} (${JSON.stringify(oldObj[key])} -> ${JSON.stringify(newObj[key])})`);
            }
        }
        for (const key of Object.keys(oldObj)) {
            if (!(key in newObj)) diffs.push(`- 삭제됨: ${key}`);
        }
    } catch(e) {
        if (oldText.trim() !== newText.trim()) diffs.push('~ (텍스트 변경됨)');
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
            if (!oldIds.has(ext.id)) diffs.push(`+ 설치 대상: ${ext.name || ext.id}`);
        }
        for (const ext of oldList) {
            if (!newIds.has(ext.id)) diffs.push(`- 삭제 대상: ${ext.name || ext.id}`);
        }
    } catch(e) {}
    return diffs;
}

// ── Apply Gist Data ──────────────────────────────────────────────

async function applyGistData(
    gistData: any,
    context: vscode.ExtensionContext,
    silent: boolean = false
): Promise<void> {
    settingsManager.backupCurrentSettings();
    outputChannel.clear();
    outputChannel.appendLine('=== Soloboi\'s Settings Sync 다운로드 결과 ===\n');
    let hasChanges = false;

    if (gistData.files['settings.json']) {
        const newText = gistData.files['settings.json'].content;
        const oldText = settingsManager.readLocalSettings();
        const diffs = generateSettingsDiff(oldText, newText);
        if (diffs.length > 0) {
            outputChannel.appendLine('[Settings.json 변경사항]');
            diffs.forEach(d => outputChannel.appendLine('  ' + d));
            outputChannel.appendLine('');
            hasChanges = true;
        }
        settingsManager.writeLocalSettings(newText);
    }
    if (gistData.files['keybindings.json']) {
        settingsManager.writeLocalKeybindings(gistData.files['keybindings.json'].content);
    }
    if (gistData.files['antigravity.json']) {
        settingsManager.writeAntigravityConfig(gistData.files['antigravity.json'].content);
    }
    if (gistData.files['browserAllowlist.txt']) {
        settingsManager.writeBrowserAllowlist(gistData.files['browserAllowlist.txt'].content);
    }
    if (gistData.files['snippets.json']) {
        settingsManager.writeSnippets(gistData.files['snippets.json'].content);
    }

    let installedCount = 0;
    let uninstalledCount = 0;

    if (gistData.files['extensions.json']) {
        const newText = gistData.files['extensions.json'].content;
        const oldText = settingsManager.readInstalledExtensions();
        const extDiffs = generateExtensionsDiff(oldText, newText);
        if (extDiffs.length > 0) {
            outputChannel.appendLine('[익스텐션(Extensions) 변경사항]');
            extDiffs.forEach(d => outputChannel.appendLine('  ' + d));
            outputChannel.appendLine('');
            hasChanges = true;
        }

        installedCount = await settingsManager.installMissingExtensions(newText);
        uninstalledCount = await settingsManager.uninstallExtraExtensions(newText);
    }

    if (!hasChanges) {
        outputChannel.appendLine('변경된 로컬 설정이 없습니다. (최신 상태)');
    }

    const now = new Date().toISOString();
    context.globalState.update(LAST_SYNC_KEY, now);
    lastSyncTime = now;
    updateStatusBar('idle');

    if (!silent) {
        let msg = 'Soloboi\'s Settings Sync 완료: 설정이 적용되었습니다.';
        if (installedCount > 0 || uninstalledCount > 0) {
            msg += ` (익스텐션 ${installedCount}개 설치, ${uninstalledCount}개 제거)`;
        }
        
        vscode.window.showInformationMessage(msg, '자세히 보기').then(selection => {
            if (selection === '자세히 보기') {
                outputChannel.show(true);
            }
        });
    }
}

// ─── Gist History ────────────────────────────────────────────────────

async function showGistHistory(context: vscode.ExtensionContext): Promise<void> {
    const token = await authManager.getToken();
    if (!token) return;

    const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
    const gistId = config.get<string>('gistId');
    if (!gistId) {
        vscode.window.showWarningMessage('Soloboi\'s Settings Sync: Gist ID가 설정되지 않았습니다.');
        return;
    }

    updateStatusBar('downloading');
    try {
        const history = await gistService.getGistHistory(gistId, token);
        if (!history || history.length === 0) {
            vscode.window.showInformationMessage('Soloboi\'s Settings Sync: Gist 히스토리가 없습니다.');
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
            title: '복원할 Gist 버전을 선택하세요',
            placeHolder: '이전 설정 버전 선택'
        });

        if (selected) {
            const sha = (selected as any).version;
            updateStatusBar('downloading');
            const gistData = await gistService.getGistRevision(gistId, sha, token);
            await applyGistData(gistData, context);
            updateStatusBar('idle');
            vscode.window.showInformationMessage('Soloboi\'s Settings Sync: 이전 버전으로 복원되었습니다.');
        }
    } catch (err: any) {
        vscode.window.showErrorMessage(`Soloboi\'s Settings Sync: 히스토리 조회 실패 — ${err.message}`);
        updateStatusBar('error');
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────

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
        vscode.window.showErrorMessage('Soloboi\'s Settings Sync: Gist 목록을 가져오지 못했습니다.');
        updateStatusBar('idle');
        return null;
    }

    const platformGists = gists.filter(g => 
        g.description && g.description.startsWith(GIST_DESCRIPTION_PREFIX)
    );

    updateStatusBar('idle');

    if (platformGists.length === 0) {
        // No existing Gist, directly create one
        return await createNewGist(token, files, silent);
    }

    // Prepare QuickPick items
    const items: vscode.QuickPickItem[] = [
        {
            label: '$(add) 새로운 동기화 Gist 생성',
            description: '현재 설정을 바탕으로 새 Gist를 생성합니다.',
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
            detail: `마지막 업데이트: ${new Date(g.updated_at).toLocaleString()}`,
            id: g.id
        } as any);
    });

    const selected = await vscode.window.showQuickPick(items, {
        title: 'Soloboi 동기화 Gist 선택',
        placeHolder: '기존 동기화 설정을 선택하거나 새로 생성하세요.'
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
    } else {
        const gistId = (selected as any).id;
        await config.update('gistId', gistId, vscode.ConfigurationTarget.Global);
        await saveCurrentProfileFromGlobal(config);
        vscode.window.showInformationMessage(`Soloboi\'s Settings Sync: 기존 Gist(${gistId})가 선택되었습니다.`);
        return gistId;
    }
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
                `Soloboi\'s Settings Sync: 새 Gist가 생성되었습니다. (기기명: ${hostname})`
            );
        }
        return result.id;
    } catch (err: any) {
        console.error('Soloboi\'s Settings Sync: Create Gist error', err);
        if (!silent) {
            vscode.window.showErrorMessage(`Soloboi\'s Settings Sync: Gist 생성 실패 — ${err.message}`);
        }
        updateStatusBar('error');
        return null;
    }
}

function buildGistFiles(): Record<string, { content: string }> | null {
    const settings = settingsManager.readLocalSettings();
    const keybindings = settingsManager.readLocalKeybindings();
    const extensions = settingsManager.readInstalledExtensions();
    const antigravityConfig = settingsManager.readAntigravityConfig();
    const browserAllowlist = settingsManager.readBrowserAllowlist();
    const snippets = settingsManager.readSnippets();

    const files: Record<string, { content: string }> = {};

    if (settings) {
        files['settings.json'] = { content: settings };
    }
    // keybindings always available (empty array if file doesn't exist)
    files['keybindings.json'] = { content: keybindings };
    // extensions always available (may be empty list)
    files['extensions.json'] = { content: extensions };
    
    if (antigravityConfig) {
        files['antigravity.json'] = { content: antigravityConfig };
    }
    if (browserAllowlist) {
        files['browserAllowlist.txt'] = { content: browserAllowlist };
    }
    if (snippets) {
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
            statusBarItem.tooltip = '설정 업로드 중...';
            break;
        case 'downloading':
            statusBarItem.text = '$(sync~spin) Downloading...';
            statusBarItem.tooltip = '설정 다운로드 중...';
            break;
        case 'error':
            statusBarItem.text = '$(error) Sync Error';
            statusBarItem.tooltip = '동기화 오류 발생';
            setTimeout(() => updateStatusBar('idle'), 5000);
            break;
        case 'logged-out':
            statusBarItem.text = '$(sign-in) Soloboi\'s Settings Sync';
            statusBarItem.tooltip = '클릭하여 로그인 및 동기화';
            break;
        default: {
            statusBarItem.text = '$(sync) Soloboi\'s Settings Sync';
            const lastSync = lastSyncTime;
            if (lastSync) {
                statusBarItem.tooltip = `마지막 동기화: ${new Date(lastSync).toLocaleString()}\n클릭하여 동기화`;
            } else {
                statusBarItem.tooltip = '클릭하여 동기화';
            }
            break;
        }
    }
}
