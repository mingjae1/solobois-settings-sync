import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as os from 'os';
import * as crypto from 'crypto';
import { AuthManager } from './auth';
import { GistData, GistService } from './gistService';
import { SettingsManager } from './settingsManager';
import { SoloboiSyncTreeProvider } from './treeProvider';
import { detectPlatform, Platform } from './platformDetector';
import { checkMarketplaceForPlatform, ExtensionAvailability, checkCustomMarketplaceUpdates, ExtensionUpdateInfo } from './marketplaceChecker';
import { marketplaceManager } from './marketplaceManager';
import { registerPrototypeCommands } from './prototypeCommands';
import { sensitiveDataGuard } from './sensitiveDataGuard';

const GIST_DESCRIPTION_PREFIX = "Soloboi's Settings Sync - ";
const GIST_DEFAULT_DESCRIPTION = "Soloboi's Settings Sync - VS Code Settings"; // Used for initial creation
const LAST_SYNC_KEY = 'soloboisSettingsSync.lastSyncTimestamp';
const LOCAL_STATE_TIMESTAMP_KEY = 'soloboisSettingsSync.localStateTimestamp';
const PENDING_UPLOAD_KEY = 'soloboisSettingsSync.pendingUpload';
const INTENTIONALLY_REMOVED_KEY = 'soloboisSettingsSync.intentionallyRemovedExtensions';
const DEFAULT_PROFILE_NAME = 'Default';

let authManager: AuthManager;
let gistService: GistService;

/** Content store for virtual diff documents (soloboi-diff: scheme). */
const diffDocumentStore = new Map<string, string>();
let settingsManager: SettingsManager;
let fileWatcher: vscode.FileSystemWatcher | undefined;
let uploadTimer: NodeJS.Timeout | undefined;
let isUploading = false;
let isDownloading = false;
let isApplyingRemoteChanges = false;
let autoUploadSuspendedUntil = 0;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let logChannel: vscode.OutputChannel;
let lastSyncTime: string | null = null;
let currentPlatform: Platform = 'unknown';

const AUTO_UPLOAD_SUPPRESSION_BUFFER_MS = 1500;
const EXTENSION_CHANGE_UPLOAD_DELAY_MS = 750;

type OmissionSummary = {
    skippedSettingKeys: string[];
    skippedAntigravityFiles: string[];
};

type GistTrustLevel = 'self' | 'trusted' | 'untrusted';

type SyncDiff = {
    settings: {
        added: string[];
        changed: string[];
        removed: string[];
    };
    extensions: {
        toInstall: string[];
        toRemove: string[];
    };
    snippets: {
        changed: boolean;
    };
};

type PendingUploadState = {
    timestamp: string;
    reason: string;
};

type SyncProfile = {
    gistId: string;
    ignoredSettings: string[];
    ignoredExtensions: string[];
};

type GettingStartedAction =
    | 'login'
    | 'useExistingGist'
    | 'createOrUpload'
    | 'syncNow'
    | 'viewDiff'
    | 'viewLog'
    | 'openSettings'
    | 'openRepo'
    | 'reportIssue';

function toErrorMessage(err: unknown): string {
    if (!err) {
        return 'Unknown error';
    }
    if (err instanceof Error) {
        return err.message;
    }
    if (typeof err === 'string') {
        return err;
    }
    try {
        return JSON.stringify(err);
    } catch {
        return String(err);
    }
}

function logLine(level: 'INFO' | 'WARN' | 'ERROR', message: string, err?: unknown): void {
    const ts = new Date().toISOString();
    const suffix = err ? ` | ${toErrorMessage(err)}` : '';
    try {
        logChannel?.appendLine(`[${ts}] ${level} ${message}${suffix}`);
    } catch {
        // ignore logging failures
    }
}

function logInfo(message: string): void {
    logLine('INFO', message);
}

function logWarn(message: string, err?: unknown): void {
    logLine('WARN', message, err);
}

function logError(message: string, err?: unknown): void {
    logLine('ERROR', message, err);
}

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

function parseGistIdFromInput(value: string): string | null {
    const input = (value || '').trim();
    if (!input) {
        return '';
    }

    const directMatch = input.match(/^[a-f0-9]{8,}$/i);
    if (directMatch) {
        return directMatch[0];
    }

    try {
        const url = new URL(input);
        const host = url.hostname.toLowerCase();
        if (host === 'gist.github.com' || host === 'www.gist.github.com' || host === 'gist.githubusercontent.com') {
            const segments = url.pathname.split('/').filter(Boolean);
            for (let index = segments.length - 1; index >= 0; index--) {
                const segment = segments[index];
                if (/^[a-f0-9]{8,}$/i.test(segment)) {
                    return segment;
                }
            }
        }
    } catch {
        // Not a URL, continue to regex fallback.
    }

    const embeddedMatch = input.match(/([a-f0-9]{8,})/i);
    return embeddedMatch ? embeddedMatch[1] : null;
}

async function runGettingStartedWizard(context: vscode.ExtensionContext): Promise<void> {
    const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
    const gistId = config.get<string>('gistId');
    const loggedIn = authManager?.isLoggedIn() ?? false;

    const items: Array<vscode.QuickPickItem & { action: GettingStartedAction }> = [];

    if (!loggedIn) {
        items.push({
            label: '$(account) Login to GitHub',
            description: 'Required to access your Gist',
            action: 'login'
        });
    }

    items.push(
        {
            label: '$(key) Use existing Gist (Set ID + Download)',
            description: gistId ? `Current: ${gistId.substring(0, 8)}…` : 'Best if you already have a sync Gist',
            action: 'useExistingGist'
        },
        {
            label: '$(cloud-upload) Create new Gist (Upload)',
            description: 'Uploads local settings and creates a new Gist if needed',
            action: 'createOrUpload'
        },
        {
            label: '$(sync) Sync Now',
            description: 'Two-way sync (upload & download)',
            action: 'syncNow'
        },
        {
            label: '$(diff) View Local vs Remote Diff',
            description: 'Preview changes without applying',
            action: 'viewDiff'
        },
        {
            label: '$(output) View Log',
            description: 'Troubleshooting details',
            action: 'viewLog'
        },
        {
            label: '$(gear) Open Settings',
            description: 'Configure sync behavior',
            action: 'openSettings'
        },
        {
            label: '$(mark-github) Open GitHub Repository',
            description: 'README / changelog / source',
            action: 'openRepo'
        },
        {
            label: '$(bug) Report an Issue',
            description: 'Bug report / feature request',
            action: 'reportIssue'
        }
    );

    const picked = await vscode.window.showQuickPick(items, {
        title: "Soloboi's Settings Sync — Getting Started",
        placeHolder: 'Pick what you want to do next'
    });

    if (!picked) {
        return;
    }

    await context.globalState.update('setupPrompted', true);

    switch (picked.action) {
        case 'login':
            await vscode.commands.executeCommand('soloboisSettingsSync.login');
            break;
        case 'useExistingGist':
            await vscode.commands.executeCommand('soloboisSettingsSync.setGistId');
            await vscode.commands.executeCommand('soloboisSettingsSync.downloadNow');
            break;
        case 'createOrUpload':
            await vscode.commands.executeCommand('soloboisSettingsSync.uploadNow');
            break;
        case 'syncNow':
            await vscode.commands.executeCommand('soloboisSettingsSync.syncNow');
            break;
        case 'viewDiff':
            await vscode.commands.executeCommand('soloboisSettingsSync.showLocalVsRemoteDiff');
            break;
        case 'viewLog':
            await vscode.commands.executeCommand('soloboisSettingsSync.showLog');
            break;
        case 'openSettings':
            await vscode.commands.executeCommand('soloboisSettingsSync.openSettings');
            break;
        case 'openRepo':
            await vscode.commands.executeCommand('soloboisSettingsSync.openRepository');
            break;
        case 'reportIssue':
            await vscode.commands.executeCommand('soloboisSettingsSync.reportIssue');
            break;
    }
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

async function installExtensionViaCLI(id: string): Promise<void> {
    try {
        await vscode.commands.executeCommand('workbench.extensions.installExtension', id);
        return;
    } catch {
        // Fall back to the CLI when the built-in install command is unavailable or fails.
    }

    const appRoot = vscode.env.appRoot;
    let cliPath: string;

    if (process.platform === 'win32') {
        cliPath = path.join(appRoot, '..', 'bin', 'code.cmd');
    } else if (process.platform === 'darwin') {
        cliPath = path.join(appRoot, '..', '..', '..', 'Contents', 'Resources', 'app', 'bin', 'code');
    } else {
        cliPath = path.join(appRoot, '..', 'bin', 'code');
    }

    if (!fs.existsSync(cliPath)) {
        cliPath = 'code';
    }

    return new Promise<void>((resolve, reject) => {
        cp.execFile(cliPath, ['--install-extension', id], (err, _stdout, stderr) => {
            if (err) {
                const stderrText = (stderr || '').trim();
                const errorText = `${err.message || ''}\n${stderrText}`.toLowerCase();

                if (errorText.includes('bad option') || errorText.includes('unknown option')) {
                    reject(new Error(
                        `Extension CLI does not support --install-extension (${cliPath})${stderrText ? `: ${stderrText}` : ''}`
                    ));
                    return;
                }

                reject(err);
                return;
            }
            resolve();
        });
    });
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

function clearPendingUpload(): void {
    if (uploadTimer) {
        clearTimeout(uploadTimer);
        uploadTimer = undefined;
    }
}

function parseTimestamp(timestamp: string | null | undefined): number | null {
    if (!timestamp) {
        return null;
    }

    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : null;
}

function getPendingUploadState(context: vscode.ExtensionContext): PendingUploadState | null {
    const pending = context.globalState.get<PendingUploadState | null>(PENDING_UPLOAD_KEY, null);
    if (!pending || typeof pending.timestamp !== 'string') {
        return null;
    }

    const timestamp = parseTimestamp(pending.timestamp);
    if (timestamp === null) {
        return null;
    }

    return {
        timestamp: new Date(timestamp).toISOString(),
        reason: typeof pending.reason === 'string' && pending.reason.trim()
            ? pending.reason.trim()
            : 'local changes'
    };
}

async function markLocalStateChanged(
    context: vscode.ExtensionContext,
    reason: string
): Promise<PendingUploadState> {
    const pending: PendingUploadState = {
        timestamp: new Date().toISOString(),
        reason
    };

    await context.globalState.update(LOCAL_STATE_TIMESTAMP_KEY, pending.timestamp);
    await context.globalState.update(PENDING_UPLOAD_KEY, pending);
    return pending;
}

async function markStateSynchronized(
    context: vscode.ExtensionContext,
    timestamp: string
): Promise<void> {
    await context.globalState.update(LAST_SYNC_KEY, timestamp);
    await context.globalState.update(LOCAL_STATE_TIMESTAMP_KEY, timestamp);
    await context.globalState.update(PENDING_UPLOAD_KEY, undefined);
    lastSyncTime = timestamp;
}

function getManagedExtensionsSnapshot(): string {
    return settingsManager.readInstalledExtensions();
}

function parseExtensionIds(content: string | null | undefined): Set<string> {
    return new Set(
        normalizeExtensionIds(
            parseExtensionList(content || '')
                .map(entry => entry.id)
        )
    );
}

async function pruneIntentionallyRemovedExtensions(
    context: vscode.ExtensionContext,
    uploadedExtensionsContent: string | null | undefined
): Promise<void> {
    const intentionallyRemoved = normalizeExtensionIds(
        context.globalState.get<string[]>(INTENTIONALLY_REMOVED_KEY, [])
    );
    if (intentionallyRemoved.length === 0) {
        return;
    }

    const uploadedIds = parseExtensionIds(uploadedExtensionsContent);
    const remaining = intentionallyRemoved.filter(id => uploadedIds.has(id));
    await context.globalState.update(INTENTIONALLY_REMOVED_KEY, remaining);
}

function getAutoUploadSuppressionWindow(config?: vscode.WorkspaceConfiguration): number {
    const cfg = config || vscode.workspace.getConfiguration('soloboisSettingsSync');
    const delay = Math.max(cfg.get<number>('autoUploadDelay', 5000), 0);
    return delay + AUTO_UPLOAD_SUPPRESSION_BUFFER_MS;
}

function suspendAutoUpload(durationMs: number): void {
    autoUploadSuspendedUntil = Math.max(
        autoUploadSuspendedUntil,
        Date.now() + Math.max(durationMs, 0)
    );
    clearPendingUpload();
}

function isAutoUploadSuspended(): boolean {
    return isDownloading || isApplyingRemoteChanges || Date.now() < autoUploadSuspendedUntil;
}

function scheduleAutoUpload(
    context: vscode.ExtensionContext,
    delayMs: number
): void {
    if (isAutoUploadSuspended()) {
        return;
    }

    clearPendingUpload();
    uploadTimer = setTimeout(async () => {
        uploadTimer = undefined;
        if (isAutoUploadSuspended()) {
            return;
        }

        const session = await authManager.getSessionSilent();
        if (session) {
            await uploadSettings(context, true);
        }
    }, Math.max(delayMs, 0));
}

async function shouldDownloadRemoteOnStartup(
    context: vscode.ExtensionContext
): Promise<boolean> {
    const pending = getPendingUploadState(context);
    if (!pending) {
        return true;
    }

    const token = await authManager.getToken();
    if (!token) {
        return false;
    }

    const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
    const gistId = config.get<string>('gistId');
    if (!gistId) {
        return false;
    }

    const gistData = await gistService.getGist(gistId, token);
    const remoteTimestamp = parseTimestamp(gistData?.updated_at);
    const pendingTimestamp = parseTimestamp(pending.timestamp);

    if (pendingTimestamp !== null && remoteTimestamp !== null && remoteTimestamp >= pendingTimestamp) {
        await context.globalState.update(PENDING_UPLOAD_KEY, undefined);
        return true;
    }

    outputChannel.appendLine(
        `Startup sync skipped remote download because local ${pending.reason} at ${pending.timestamp} is newer than the Gist.`
    );

    const uploaded = await uploadSettings(context, true);
    if (!uploaded) {
        outputChannel.appendLine(
            'Pending local changes could not be uploaded during startup. Remote download remains skipped to avoid overwriting local state.'
        );
    }

    return false;
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
    const customMarketplaceUrl = vscode.workspace.getConfiguration('soloboisSettingsSync').get<string>('customMarketplaceUrl', '');
    const availability = await checkMarketplaceForPlatform(ids, currentPlatform, customMarketplaceUrl || undefined);

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

async function promptUnknownExtensionsAction(
    unknownIds: string[],
    silent: boolean
): Promise<{ toInstall: string[]; toIgnore: string[] }> {
    if (silent || unknownIds.length === 0) {
        return { toInstall: [], toIgnore: [] };
    }

    const items: (vscode.QuickPickItem & { id: string; action: 'install' | 'skip' | 'ignore' })[] =
        unknownIds.flatMap(id => [
            { label: `$(cloud-download) Install anyway`, description: id, id, action: 'install' as const },
            { label: `$(close) Add to ignored list`, description: id, id, action: 'ignore' as const }
        ]);

    const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: `${unknownIds.length} extension(s) could not be verified in marketplace`,
        placeHolder: 'Select actions (unselected = skip this time)'
    });

    if (!selected) {
        return { toInstall: [], toIgnore: [] };
    }

    const toInstall = selected.filter(i => i.action === 'install').map(i => i.id);
    const toIgnore = selected.filter(i => i.action === 'ignore').map(i => i.id);
    return { toInstall, toIgnore };
}

// ─── 활성화 (Activation) ─────────────────────────────────────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext) {
    console.log('Soloboi\'s Settings Sync is now active.');

    // Initialize Services
    authManager = new AuthManager(context);
    gistService = new GistService();
    settingsManager = new SettingsManager();
    currentPlatform = detectPlatform();
    console.log(`Soloboi's Settings Sync: detected platform = ${currentPlatform} (appName: ${vscode.env.appName})`);
    await initializeProfiles();
    lastSyncTime = context.globalState.get<string>(LAST_SYNC_KEY) || null;

    // Initialize UI
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'soloboisSettingsSync.syncNow';
    context.subscriptions.push(statusBarItem);
    updateStatusBar('idle');
    statusBarItem.show();

    // Output channels
    outputChannel = vscode.window.createOutputChannel("Soloboi's Settings Sync");
    context.subscriptions.push(outputChannel);
    // Log channel (kept separate from the report output, so diff/preview clears won't wipe logs)
    logChannel = vscode.window.createOutputChannel("Soloboi's Settings Sync Log", { log: true });
    context.subscriptions.push(logChannel);

    // Virtual document provider for vscode.diff panels
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('soloboi-diff', {
            provideTextDocumentContent(uri: vscode.Uri): string {
                return diffDocumentStore.get(uri.path) ?? '';
            }
        })
    );
    logInfo('Activated extension.');
    logInfo(`Detected platform=${currentPlatform} (appName=${vscode.env.appName})`);

    // Register Tree View
    const treeProvider = new SoloboiSyncTreeProvider(authManager, gistService);
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('soloboisSettingsSync.treeView', treeProvider)
    );

    // Keep ignoredExtensions clean when extensions are removed.
    await cleanupIgnoredExtensions();
    let extensionSnapshot = getManagedExtensionsSnapshot();
    context.subscriptions.push(
        vscode.extensions.onDidChange(async () => {
            const nextSnapshot = getManagedExtensionsSnapshot();
            const extensionsChanged = nextSnapshot !== extensionSnapshot;

            if (extensionsChanged) {
                const prevIds = parseExtensionIds(extensionSnapshot);
                const nextIds = parseExtensionIds(nextSnapshot);
                const removed = [...prevIds].filter(id => !nextIds.has(id));

                if (removed.length > 0) {
                    const existing = normalizeExtensionIds(
                        context.globalState.get<string[]>(INTENTIONALLY_REMOVED_KEY, [])
                    );
                    const updated = normalizeExtensionIds([...existing, ...removed]);
                    await context.globalState.update(INTENTIONALLY_REMOVED_KEY, updated);

                    // Add contributed setting keys from removed extensions to ignoredSettings.
                    for (const removedId of removed) {
                        const ext = vscode.extensions.getExtension(removedId);
                        if (!ext) {
                            continue;
                        }

                        const contributes = ext.packageJSON?.contributes?.configuration;
                        if (!contributes) {
                            continue;
                        }

                        const configs = Array.isArray(contributes) ? contributes : [contributes];
                        const keys: string[] = configs.flatMap(
                            (c: any) => Object.keys(c?.properties ?? {})
                        );

                        if (keys.length === 0) {
                            continue;
                        }

                        const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
                        const existingIgnored = config.get<string[]>('ignoredSettings', []);
                        const toAdd = keys.filter(key => !existingIgnored.includes(key));
                        if (toAdd.length === 0) {
                            continue;
                        }

                        await config.update(
                            'ignoredSettings',
                            [...existingIgnored, ...toAdd],
                            vscode.ConfigurationTarget.Global
                        );

                        outputChannel.appendLine(
                            `[Auto-ignore] ${removedId} removal detected -> added ${toAdd.length} setting(s) to ignoredSettings: ${toAdd.slice(0, 3).join(', ')}${toAdd.length > 3 ? ' ...' : ''}`
                        );
                    }
                }
            }

            extensionSnapshot = nextSnapshot;

            await cleanupIgnoredExtensions();

            if (!extensionsChanged || isAutoUploadSuspended()) {
                return;
            }

            const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
            if (!config.get<boolean>('autoSync', false) || !config.get<boolean>('autoUploadOnChange', true)) {
                return;
            }

            await markLocalStateChanged(context, 'extension list changed');
            scheduleAutoUpload(context, EXTENSION_CHANGE_UPLOAD_DELAY_MS);
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

    // ─── 명령 등록 (Register Commands) ────────────────────────────────────────────────────────────────────────────────

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

    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.setCustomMarketplaceUrl', async () => {
            const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
            const current = config.get<string>('customMarketplaceUrl', '');
            const input = await vscode.window.showInputBox({
                title: 'Custom Marketplace URL',
                prompt: 'Enter an OpenVSX-compatible marketplace base URL, or leave empty to clear.',
                value: current,
                placeHolder: 'https://my-marketplace.example.com'
            });
            if (input === undefined) { return; } // cancelled
            await config.update('customMarketplaceUrl', input.trim(), vscode.ConfigurationTarget.Global);
            if (input.trim()) {
                vscode.window.showInformationMessage(`Soloboi's Settings Sync: Custom marketplace URL set.`);
            } else {
                vscode.window.showInformationMessage(`Soloboi's Settings Sync: Custom marketplace URL cleared.`);
            }
            treeProvider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.togglePublicGist', async () => {
            const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
            const current = config.get<boolean>('publicGist', false);
            await config.update('publicGist', !current, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(
                `Soloboi's Settings Sync: New Gists will be created as ${!current ? 'public' : 'private'}.`
            );
            treeProvider.refresh();
        })
    );

    // ── Share Your Settings ────────────────────────────────────────────────
    context.subscriptions.push(
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
                    : 'No public gists yet — create one to share your settings'
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
                        `Soloboi's Settings Sync: Link copied! Share it with friends 🎉\n${url}`
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
                    title: 'Share Your Settings — Name',
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
                    true  // public
                );

                const url = `https://gist.github.com/${(gistData as any)?.owner?.login ?? ''}/${gistData?.id}`;
                await vscode.env.clipboard.writeText(url);
                vscode.window.showInformationMessage(
                    `Soloboi's Settings Sync: Settings shared! URL copied 🎉\n${url}`,
                    'Open in Browser'
                ).then(sel => {
                    if (sel === 'Open in Browser') {
                        vscode.env.openExternal(vscode.Uri.parse(url));
                    }
                });
                logInfo(`[Share] Created public settings gist: ${url}`);
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

    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.showLocalVsRemoteDiff', async () => {
            const token = await authManager.getToken();
            if (!token) {
                vscode.window.showWarningMessage("Soloboi's Settings Sync: Please log in to GitHub first.");
                return;
            }
            const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
            const gistId = config.get<string>('gistId');
            if (!gistId) {
                vscode.window.showWarningMessage("Soloboi's Settings Sync: Gist ID is not set.");
                return;
            }
            updateStatusBar('downloading');
            try {
                const gistData = await gistService.getGist(gistId, token);
                if (!gistData?.files) {
                    throw new Error('Invalid Gist data');
                }

                // Open one diff panel per file that exists in both local and remote
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
                    vscode.window.showInformationMessage("Soloboi's Settings Sync: No files to diff.");
                    return;
                }

                // Open each file as a side-by-side diff in VS Code's built-in diff editor
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
                        `${file.filename}  Remote (Gist) ↔ Local`,
                        { preview: filesToDiff.length === 1 }
                    );
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Soloboi's Settings Sync: Diff failed: ${err.message}`);
            } finally {
                updateStatusBar('idle');
            }
        })
    );

    // ── Marketplace Manager commands (Task #1) ─────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.addMarketplace', async () => {
            const input = await vscode.window.showInputBox({
                title: 'Add Marketplace',
                prompt: 'Enter an OpenVSX-compatible marketplace base URL.',
                placeHolder: 'https://my-marketplace.example.com'
            });
            if (!input) { return; }
            const result = await marketplaceManager.addMarketplace(input.trim());
            if (result) {
                vscode.window.showInformationMessage(
                    `Soloboi's Settings Sync: Marketplace "${result.domain}" added.`
                );
                treeProvider.refresh();
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.removeMarketplace', async (domain?: string) => {
            const registry = marketplaceManager.getRegistry();
            const domains = Object.keys(registry);
            if (domains.length === 0) {
                vscode.window.showInformationMessage(`Soloboi's Settings Sync: No marketplaces registered.`);
                return;
            }

            const target = domain ?? await vscode.window.showQuickPick(
                domains.map(d => ({ label: d, description: registry[d] })),
                { title: 'Remove Marketplace', placeHolder: 'Select a marketplace to remove' }
            ).then(sel => sel?.label);

            if (!target) { return; }
            await marketplaceManager.removeMarketplace(target);
            vscode.window.showInformationMessage(
                `Soloboi's Settings Sync: Marketplace "${target}" removed.`
            );
            treeProvider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.reorderMarketplace', async () => {
            const ordered = marketplaceManager.getOrderedMarketplaces();
            if (ordered.length < 2) {
                vscode.window.showInformationMessage(`Soloboi's Settings Sync: Need at least 2 marketplaces to reorder.`);
                return;
            }

            const items = ordered.map((e, i) => ({
                label: `${i + 1}. ${e.domain}`,
                description: e.url,
                domain: e.domain
            }));

            const selected = await vscode.window.showQuickPick(items, {
                title: 'Reorder — select marketplace to move UP',
                placeHolder: 'Select marketplace to promote (move to top)',
                canPickMany: false
            });
            if (!selected) { return; }

            const newOrder = [
                selected.domain,
                ...ordered.map(e => e.domain).filter(d => d !== selected.domain)
            ];
            await marketplaceManager.reorderMarketplace(newOrder);
            vscode.window.showInformationMessage(
                `Soloboi's Settings Sync: "${selected.domain}" moved to top of scan order.`
            );
            treeProvider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.toggleCustomMarketplaceAutoUpdate', async () => {
            const cfg = vscode.workspace.getConfiguration('soloboisSettingsSync');
            const current = cfg.get<boolean>('customMarketplaceAutoUpdate', false);
            await cfg.update('customMarketplaceAutoUpdate', !current, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(
                `Soloboi's Settings Sync: Custom marketplace auto-update ${!current ? 'enabled' : 'disabled'}.`
            );
            treeProvider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.removePrivateExtension', async (extId?: string) => {
            const cfg = vscode.workspace.getConfiguration('soloboisSettingsSync');
            const existing: any[] = cfg.get('privateExtensions', []);

            const target = extId ?? await vscode.window.showQuickPick(
                existing.map((e: any) => ({ label: e.id, description: `v${e.version}` })),
                { title: 'Remove Private Extension', placeHolder: 'Select extension to remove' }
            ).then(sel => sel?.label);

            if (!target) { return; }

            const updated = existing.filter((e: any) => e.id !== target);
            await cfg.update('privateExtensions', updated, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(
                `Soloboi's Settings Sync: "${target}" removed from private extensions.`
            );
            treeProvider.refresh();
        })
    );

    // ── Custom Marketplace Update Checker (Task #2) ────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.checkCustomMarketplaceUpdates', async () => {
            const marketplaceUrls = marketplaceManager.getOrderedUrls();
            if (marketplaceUrls.length === 0) {
                vscode.window.showInformationMessage(
                    `Soloboi's Settings Sync: No custom marketplaces registered. Add one first.`
                );
                return;
            }

            updateStatusBar('downloading');
            outputChannel.appendLine('[Custom Marketplace] Checking for updates...');

            try {
                const installed = vscode.extensions.all
                    .filter(e => !e.id.startsWith('vscode.'))
                    .map(e => ({ id: e.id, version: e.packageJSON?.version ?? '0.0.0' }));

                const updates = await checkCustomMarketplaceUpdates(installed, marketplaceUrls);

                if (updates.length === 0) {
                    vscode.window.showInformationMessage(`Soloboi's Settings Sync: All custom marketplace extensions are up to date.`);
                    outputChannel.appendLine('[Custom Marketplace] No updates found.');
                    return;
                }

                const cfg = vscode.workspace.getConfiguration('soloboisSettingsSync');
                const autoUpdate = cfg.get<boolean>('customMarketplaceAutoUpdate', false);

                if (autoUpdate) {
                    for (const upd of updates) {
                        await installFromVsixUrl(upd, outputChannel);
                    }
                    vscode.window.showInformationMessage(
                        `Soloboi's Settings Sync: Auto-installed ${updates.length} update(s).`
                    );
                } else {
                    const quickPickItems = updates.map(u => ({
                        label: u.id,
                        description: `${u.currentVersion} → ${u.latestVersion}`,
                        detail: `From: ${u.marketplaceDomain}`,
                        update: u
                    }));

                    const selected = await vscode.window.showQuickPick(quickPickItems, {
                        title: `Custom Marketplace Updates (${updates.length} available)`,
                        placeHolder: 'Select extensions to update',
                        canPickMany: true
                    });

                    if (!selected || selected.length === 0) { return; }

                    for (const item of selected) {
                        await installFromVsixUrl(item.update, outputChannel);
                    }
                    vscode.window.showInformationMessage(
                        `Soloboi's Settings Sync: Installed ${selected.length} update(s).`
                    );
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(
                    `Soloboi's Settings Sync: Update check failed: ${err?.message ?? err}`
                );
            } finally {
                updateStatusBar('idle');
            }
        })
    );

    // ── Private Extension Sync (Task #3) ──────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.registerPrivateExtension', async () => {
            // Step 1: detect unknown installed extensions
            const cfg = vscode.workspace.getConfiguration('soloboisSettingsSync');
            const existing = cfg.get<any[]>('privateExtensions', []);
            const existingIds = new Set(existing.map((e: any) => (e.id ?? '').toLowerCase()));

            const unknownExts = vscode.extensions.all.filter(e =>
                !e.id.startsWith('vscode.') &&
                !existingIds.has(e.id.toLowerCase())
            );

            const idInput = await vscode.window.showQuickPick(
                [
                    ...unknownExts.map(e => ({
                        label: e.id,
                        description: `v${e.packageJSON?.version ?? '?'} (installed)`,
                        id: e.id,
                        version: e.packageJSON?.version ?? '0.0.0'
                    })),
                    { label: '$(edit) Enter manually...', description: '', id: '__manual__', version: '' }
                ],
                {
                    title: 'Register Private Extension — Step 1: Select Extension',
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

            // Step 2: VSIX URL (optional)
            const vsixUrl = await vscode.window.showInputBox({
                title: 'Register Private Extension — Step 2: VSIX URL (optional)',
                prompt: 'Enter a direct VSIX download URL, or leave empty to skip.',
                placeHolder: 'https://example.com/my-tool-1.0.0.vsix'
            });

            // Step 3: Note (optional)
            const note = await vscode.window.showInputBox({
                title: 'Register Private Extension — Step 3: Note (optional)',
                prompt: 'Add a note for this extension (e.g. where to find it).',
                placeHolder: 'Internal tool — contact IT for access'
            });

            const entry: any = { id: extId, version: extVersion };
            if (vsixUrl?.trim()) { entry.vsixUrl = vsixUrl.trim(); }
            if (note?.trim()) { entry.note = note.trim(); }

            const updated = [...existing.filter((e: any) => e.id !== extId), entry];
            await cfg.update('privateExtensions', updated, vscode.ConfigurationTarget.Global);

            const localPath = getExtensionLocalPath(extId, extVersion);
            const msg = vsixUrl?.trim()
                ? `Soloboi's Settings Sync: "${extId}" registered. VSIX URL stored — will auto-install on sync.`
                : `Soloboi's Settings Sync: "${extId}" registered.\n⚠️ No VSIX URL provided — manual install required.\nLocal path hint: ${localPath}`;

            vscode.window.showInformationMessage(msg);
            outputChannel.appendLine(`[Private Extensions] Registered: ${extId} v${extVersion}`);
            if (!vsixUrl?.trim()) {
                outputChannel.appendLine(`  Manual install path: ${localPath}`);
                outputChannel.appendLine(`  To enable auto-sync, provide a VSIX URL when registering.`);
            }
            treeProvider.refresh();
        })
    );

    // ── Help / UX shortcuts ───────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.openSettings', async () => {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'soloboisSettingsSync');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.openRepository', async () => {
            const repoUrl = (context.extension.packageJSON?.repository?.url as string | undefined) || '';
            if (!repoUrl) {
                vscode.window.showWarningMessage("Soloboi's Settings Sync: Repository URL is not set.");
                return;
            }
            await vscode.env.openExternal(vscode.Uri.parse(repoUrl));
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.reportIssue', async () => {
            const issuesUrl = (context.extension.packageJSON?.bugs?.url as string | undefined) || '';
            if (!issuesUrl) {
                vscode.window.showWarningMessage("Soloboi's Settings Sync: Issues URL is not set.");
                return;
            }
            await vscode.env.openExternal(vscode.Uri.parse(issuesUrl));
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.showLog', async () => {
            logChannel.show(true);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.getStarted', async () => {
            await runGettingStartedWizard(context);
        })
    );

    registerPrototypeCommands(context, {
        authManager,
        gistService,
        settingsManager,
        outputChannel
    });

    // ─── 설정 마법사 (Setup Wizard) ──────────────────────────────────────────────────────────────────────────────────

    const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
    const gistId = config.get<string>('gistId');
    const prompted = context.globalState.get<boolean>('setupPrompted', false);

    if (!gistId && !prompted) {
        vscode.window.showInformationMessage(
            "Welcome to Soloboi's Settings Sync. Open Getting Started?",
            'Getting Started',
            'Later'
        ).then(async selection => {
            if (selection === 'Getting Started') {
                await runGettingStartedWizard(context);
            } else if (selection === 'Later') {
                await context.globalState.update('setupPrompted', true);
            }
        });
    }

    // ─── 시작 시 자동 동기화 (Startup Auto-Sync) ───────────────────────────────────────────────────────────────────

    if (config.get<boolean>('autoSync', false) && config.get<boolean>('autoSyncOnStartup')) {
        // Delay slightly to let VS Code finish initialising
        setTimeout(async () => {
            const session = await authManager.getSessionSilent();
            if (session) {
                if (await shouldDownloadRemoteOnStartup(context)) {
                    await downloadSettings(context, true);
                }
            }
        }, 3000);
    }

    // ── Custom Marketplace Startup Update Check (Task #2) ─────────────────
    const updateCheckSetting = config.get<string>('customMarketplaceUpdateCheck', 'disabled');
    if (updateCheckSetting === 'startup') {
        setTimeout(async () => {
            const marketplaceUrls = marketplaceManager.getOrderedUrls();
            if (marketplaceUrls.length === 0) { return; }
            try {
                const installed = vscode.extensions.all
                    .filter(e => !e.id.startsWith('vscode.'))
                    .map(e => ({ id: e.id, version: e.packageJSON?.version ?? '0.0.0' }));
                const updates = await checkCustomMarketplaceUpdates(installed, marketplaceUrls);
                if (updates.length === 0) { return; }
                const autoUpdate = config.get<boolean>('customMarketplaceAutoUpdate', false);
                if (autoUpdate) {
                    for (const upd of updates) {
                        await installFromVsixUrl(upd, outputChannel);
                    }
                    vscode.window.showInformationMessage(
                        `Soloboi's Settings Sync: Auto-installed ${updates.length} custom marketplace update(s).`
                    );
                } else {
                    vscode.window.showInformationMessage(
                        `Soloboi's Settings Sync: ${updates.length} custom marketplace update(s) available.`,
                        'Update Now'
                    ).then(sel => {
                        if (sel === 'Update Now') {
                            vscode.commands.executeCommand('soloboisSettingsSync.checkCustomMarketplaceUpdates');
                        }
                    });
                }
            } catch {
                // silent — startup check should not interrupt the user
            }
        }, 5000);
    }

    // ─── 파일 감시자 (File Watchers) ─────────────────────────────────────────────────────────────────────────────

    setupFileWatchers(context);
}

// ─── 비활성화 (Deactivation) ─────────────────────────────────────────────────────────────────────────────────────────────

export function deactivate(): Thenable<void> | undefined {
    // Upload current settings on exit
    if (authManager?.isLoggedIn()) {
        // We can't fully await here, but we return the promise so VS Code waits
        return (async () => {
            try {
                const token = await authManager.getToken();
                if (!token) { return; }
                const baseFiles = buildGistFiles();
                if (!baseFiles) { return; }

                const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
                const gistId = config.get<string>('gistId');
                if (gistId) {
                    const currentGist = await gistService.getGist(gistId, token);
                    const files = withSyncMetadataFiles(baseFiles, currentGist?.files);
                    const filesToDelete = getManagedGistFilesToDelete(currentGist?.files, files);
                    await gistService.updateGist(gistId, files, token, undefined, filesToDelete);
                    console.log('Soloboi\'s Settings Sync: Uploaded settings on exit.');
                    logInfo('Uploaded settings on exit.');
                }
            } catch (err) {
                console.error('Soloboi\'s Settings Sync: Failed to upload on exit', err);
                logError('Failed to upload on exit.', err);
            }
        })();
    }
    return undefined;
}

// ─── 설정 업로드 (Upload Settings) ─────────────────────────────────────────────────────────────────────────────

async function uploadSettings(
    context: vscode.ExtensionContext,
    silent: boolean = false
): Promise<boolean> {
    if (isUploading || isDownloading || isApplyingRemoteChanges) { return false; }
    isUploading = true;
    updateStatusBar('uploading');
    logInfo('Upload started.');

    try {
        const token = await authManager.getToken();
        if (!token) {
            if (!silent) {
                vscode.window.showWarningMessage("Soloboi's Settings Sync: Please log in to GitHub first.");
            }
            logWarn('Upload aborted: missing GitHub token.');
            return false;
        }

        const baseFiles = buildGistFiles();
        if (!baseFiles) {
            if (!silent) {
                vscode.window.showErrorMessage("Soloboi's Settings Sync: No sync files were generated.");
            }
            logError('Upload failed: no sync files were generated.');
            return false;
        }

        const filesForCreate = withSyncMetadataFiles(baseFiles);

        const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
        let gistId = config.get<string>('gistId');

        if (!gistId) {
            const newId = await selectOrCreateGist(context, token, filesForCreate, silent);
            if (!newId) {
                return false;
            }
            gistId = newId;
        }

        const dateStr = new Date().toLocaleString();
        const hostname = os.hostname();
        const description = `${GIST_DESCRIPTION_PREFIX}${hostname} (${dateStr})`;
        const currentGist = await gistService.getGist(gistId, token);
        const files = withSyncMetadataFiles(baseFiles, currentGist?.files);
        const filesToDelete = getManagedGistFilesToDelete(currentGist?.files, files);

        await gistService.updateGist(gistId, files, token, description, filesToDelete);
        await pruneIntentionallyRemovedExtensions(context, files['extensions.json']?.content);
        if (!silent) {
            const selection = await vscode.window.showInformationMessage(
                "Soloboi's Settings Sync: Uploaded to Gist.",
                'Open Gist',
                'View Output',
                'View Log'
            );
            if (selection === 'Open Gist') {
                await vscode.env.openExternal(vscode.Uri.parse(`https://gist.github.com/${gistId}`));
            } else if (selection === 'View Output') {
                outputChannel.show(true);
            } else if (selection === 'View Log') {
                logChannel.show(true);
            }
        }

        const now = new Date().toISOString();
        await markStateSynchronized(context, now);
        updateStatusBar('idle');
        logInfo(`Upload completed. gistId=${gistId ?? ''}`);
        return true;

    } catch (err: any) {
        console.error("Soloboi's Settings Sync upload error:", err);
        logError('Upload failed.', err);
        if (!silent) {
            vscode.window.showErrorMessage(
                `Soloboi's Settings Sync: Upload failed: ${err.message}`,
                'View Log',
                'View Output'
            ).then(selection => {
                if (selection === 'View Log') {
                    logChannel.show(true);
                } else if (selection === 'View Output') {
                    outputChannel.show(true);
                }
            });
        }
        updateStatusBar('error');
        return false;
    } finally {
        isUploading = false;
    }
}

// ─── Diff panel helper ────────────────────────────────────────────────────────

async function openSyncDiffPanels(gistData: GistData): Promise<void> {
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
            `${file.filename}  Remote (Gist) ↔ Local`,
            { preview: filesToDiff.length === 1 }
        );
    }
}

// ─── 설정 다운로드 (Download Settings) ───────────────────────────────────────────────────────────────────────────

async function downloadSettings(
    context: vscode.ExtensionContext,
    silent: boolean = false,
    forceOmissionNotice: boolean = false
): Promise<boolean> {
    if (isDownloading || isUploading) {
        return false;
    }
    isDownloading = true;
    updateStatusBar('downloading');
    logInfo('Download started.');

    try {
        const token = await authManager.getToken();
        if (!token) {
            if (!silent) {
                vscode.window.showWarningMessage("Soloboi's Settings Sync: Please log in to GitHub first.");
            }
            logWarn('Download aborted: missing GitHub token.');
            return false;
        }

        const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
        let gistId = config.get<string>('gistId');
        const suppressionWindow = getAutoUploadSuppressionWindow(config);

        if (!gistId) {
            if (silent) {
                return false;
            }

            const baseFiles = buildGistFiles();
            const filesForCreate = baseFiles ? withSyncMetadataFiles(baseFiles) : null;
            const newId = await selectOrCreateGist(context, token, filesForCreate as any, silent);
            if (!newId) {
                return false;
            }
            gistId = newId;
        }

        const gistData = await gistService.getGist(gistId, token);
        if (!gistData?.files) {
            throw new Error('Invalid Gist data');
        }

        let previewConfirmed = false;
        if (!silent && config.get<boolean>('syncPreview', true)) {
            const trustLevel = getGistTrustLevel(gistData, gistId);
            const diff = await computeSyncDiff(gistData, context, gistId, trustLevel);
            await openSyncDiffPanels(gistData);
            const selection = await vscode.window.showInformationMessage(
                "Review the diff tabs above, then choose to apply or cancel.",
                'Apply',
                'Cancel'
            );

            if (selection !== 'Apply') {
                updateStatusBar('idle');
                return false;
            }
            previewConfirmed = true;
        }

        suspendAutoUpload(suppressionWindow);
        isApplyingRemoteChanges = true;
        try {
            await applyGistData(gistData, context, silent, forceOmissionNotice, previewConfirmed);
        } finally {
            isApplyingRemoteChanges = false;
            suspendAutoUpload(suppressionWindow);
        }
        if (!silent) {
            const selection = await vscode.window.showInformationMessage(
                "Soloboi's Settings Sync: Downloaded and applied.",
                'View Output',
                'View Diff',
                'View Log'
            );
            if (selection === 'View Output') {
                outputChannel.show(true);
            } else if (selection === 'View Diff') {
                await vscode.commands.executeCommand('soloboisSettingsSync.showLocalVsRemoteDiff');
            } else if (selection === 'View Log') {
                logChannel.show(true);
            }
        }
        logInfo(`Download completed. gistId=${gistId ?? ''}`);
        return true;

    } catch (err: any) {
        console.error("Soloboi's Settings Sync download error:", err);
        logError('Download failed.', err);
        if (!silent) {
            vscode.window.showErrorMessage(
                `Soloboi's Settings Sync: Download failed: ${err.message}`,
                'View Log',
                'View Output'
            ).then(selection => {
                if (selection === 'View Log') {
                    logChannel.show(true);
                } else if (selection === 'View Output') {
                    outputChannel.show(true);
                }
            });
        }
        updateStatusBar('error');
        return false;
    } finally {
        isDownloading = false;
    }
}

// ─── 전체 동기화 (Full Sync) ─────────────────────────────────────────────────────────────────────────────

async function fullSync(context: vscode.ExtensionContext): Promise<void> {
    const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
    const gistId = config.get<string>('gistId');

    if (gistId) {
        const downloaded = await downloadSettings(context, true, true);
        if (!downloaded) {
            logWarn('Full sync aborted: download step failed (upload skipped).');
            vscode.window.showWarningMessage(
                "Soloboi's Settings Sync: Download step failed. Upload skipped to avoid overwriting remote settings."
            );
            return;
        }
        await uploadSettings(context, false);
        vscode.window.showInformationMessage(
            "Soloboi's Settings Sync: Sync complete!",
            'View Output',
            'View Diff',
            'View Log'
        ).then(async selection => {
            if (selection === 'View Output') {
                outputChannel.show(true);
            } else if (selection === 'View Diff') {
                await vscode.commands.executeCommand('soloboisSettingsSync.showLocalVsRemoteDiff');
            } else if (selection === 'View Log') {
                logChannel.show(true);
            }
        });
    } else {
        await uploadSettings(context, false);
    }
}

// ─── 파일 감시자 (File Watchers) ─────────────────────────────────────────────────────────────────────────────

function setupFileWatchers(context: vscode.ExtensionContext): void {
    const settingsDir = settingsManager.getUserSettingsDir();
    if (!settingsDir) { return; }

    const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
    if (!config.get<boolean>('autoSync', false)) { return; }
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

    const scheduleUpload = async (reason: string) => {
        if (isAutoUploadSuspended()) {
            return;
        }

        await markLocalStateChanged(context, reason);
        scheduleAutoUpload(context, delay);
    };

    fileWatcher.onDidChange(() => {
        void scheduleUpload('settings or keybindings changed');
    });
    fileWatcher.onDidCreate(() => {
        void scheduleUpload('settings or keybindings created');
    });
    fileWatcher.onDidDelete(() => {
        void scheduleUpload('settings or keybindings deleted');
    });

    context.subscriptions.push(fileWatcher);

    if (snippetsWatcher) {
        snippetsWatcher.onDidChange(() => {
            void scheduleUpload('snippets changed');
        });
        snippetsWatcher.onDidCreate(() => {
            void scheduleUpload('snippets created');
        });
        snippetsWatcher.onDidDelete(() => {
            void scheduleUpload('snippets deleted');
        });
        context.subscriptions.push(snippetsWatcher);
    }

    if (antigravityWatcher) {
        antigravityWatcher.onDidChange(() => {
            void scheduleUpload('antigravity config changed');
        });
        antigravityWatcher.onDidCreate(() => {
            void scheduleUpload('antigravity config created');
        });
        antigravityWatcher.onDidDelete(() => {
            void scheduleUpload('antigravity config deleted');
        });
        context.subscriptions.push(antigravityWatcher);
    }
}

// ─── Gist 데이터 적용 (Apply Gist Data) ─────────────────────────────────────────────────────────────────────────────

// ─── Diff 도우미 (Diff Helpers) ───────────────────────────────────────────────────────────────────────────────────

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

type SyncManifest = {
    version?: number;
    timestamp?: string;
    hashes?: Record<string, string>;
    changedFiles?: string[];
};

function sha256(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function getGistTrustLevel(gistData: any, gistId: string): GistTrustLevel {
    const ownerLogin = typeof gistData?.owner?.login === 'string' ? gistData.owner.login.trim() : '';
    const accountLabel = (authManager.getAccountLabel() || '').trim();
    if (ownerLogin && accountLabel && ownerLogin.toLowerCase() === accountLabel.toLowerCase()) {
        return 'self';
    }

    const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
    const trustMap = config.get<Record<string, string>>('gistTrust', {}) || {};
    const entry = (trustMap[gistId] || '').trim().toLowerCase();
    return entry === 'trusted' ? 'trusted' : 'untrusted';
}

function readSyncManifest(fileMap: Record<string, { content?: string }>): SyncManifest | null {
    const raw = fileMap['sync-manifest.json']?.content;
    if (!raw) {
        return null;
    }

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }
        return parsed as SyncManifest;
    } catch {
        return null;
    }
}

function getLocalComparableContent(filename: string): string | null {
    const normalized = filename.toLowerCase();
    if (normalized === 'settings.json') {
        return settingsManager.readLocalSettings();
    }
    if (normalized === 'keybindings.json') {
        return settingsManager.readLocalKeybindings();
    }
    if (normalized === 'extensions.json') {
        return settingsManager.readInstalledExtensions();
    }
    if (normalized === 'snippets.json') {
        return settingsManager.readSnippets();
    }
    if (normalized === 'antigravity.json') {
        return settingsManager.readAntigravityConfig();
    }
    if (normalized === 'browserallowlist.txt') {
        return settingsManager.readBrowserAllowlist();
    }
    return null;
}

function computeHashSkipSet(
    fileMap: Record<string, { content?: string }>,
    syncOptions: SyncOptions,
    antigravityMode: boolean
): Set<string> {
    const manifest = readSyncManifest(fileMap);
    const hashes = manifest?.hashes || {};
    const skip = new Set<string>();

    for (const [filename, expectedHash] of Object.entries(hashes)) {
        const normalized = (filename || '').toLowerCase();
        if (!normalized || typeof expectedHash !== 'string' || !expectedHash) {
            continue;
        }

        if (normalized === 'settings.json' && (!syncOptions.syncSettings || !antigravityMode)) {
            continue;
        }
        if (normalized === 'keybindings.json' && !syncOptions.syncKeybindings) {
            continue;
        }
        if (normalized === 'extensions.json' && !syncOptions.syncExtensions) {
            continue;
        }
        if (normalized === 'snippets.json' && !syncOptions.syncSnippets) {
            continue;
        }
        if (
            (normalized === 'antigravity.json' || normalized === 'browserallowlist.txt')
            && (!syncOptions.syncAntigravityConfig || !antigravityMode)
        ) {
            continue;
        }

        const localContent = getLocalComparableContent(normalized);
        if (localContent === null) {
            continue;
        }

        if (sha256(localContent) === expectedHash) {
            skip.add(normalized);
        }
    }

    return skip;
}

function generateSettingsKeyDiff(
    oldText: string | null,
    newText: string
): { added: string[]; changed: string[]; removed: string[] } {
    if (!oldText) {
        return { added: [], changed: ['(local file missing, full write)'], removed: [] };
    }

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
                    if (char === '"' && str[i - 1] !== '\\') {
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
            return cleaned.replace(/,\s*([\]}])/g, '$1');
        };

        const oldObj = JSON.parse(stripJsonc(oldText)) || {};
        const newObj = JSON.parse(stripJsonc(newText)) || {};

        const added: string[] = [];
        const changed: string[] = [];
        const removed: string[] = [];

        for (const key of Object.keys(newObj)) {
            if (!(key in oldObj)) {
                added.push(key);
            } else if (JSON.stringify(oldObj[key]) !== JSON.stringify(newObj[key])) {
                changed.push(key);
            }
        }

        for (const key of Object.keys(oldObj)) {
            if (!(key in newObj)) {
                removed.push(key);
            }
        }

        return { added, changed, removed };
    } catch {
        return { added: [], changed: ['(text changed)'], removed: [] };
    }
}

async function computeSyncDiff(
    gistData: any,
    context: vscode.ExtensionContext,
    gistId: string,
    trustLevel: GistTrustLevel
): Promise<SyncDiff> {
    const fileMap = (gistData?.files || {}) as Record<string, { content?: string }>;
    const syncOptions = getSyncOptions();
    const antigravityMode = isAntigravityPlatform(currentPlatform);
    const skipByHash = computeHashSkipSet(fileMap, syncOptions, antigravityMode);

    const diff: SyncDiff = {
        settings: { added: [], changed: [], removed: [] },
        extensions: { toInstall: [], toRemove: [] },
        snippets: { changed: false }
    };

    if (syncOptions.syncSettings && fileMap['settings.json'] && !skipByHash.has('settings.json')) {
        const remoteSettings = fileMap['settings.json'].content || '{}';
        const filtered = filterSettingsByPlatform(remoteSettings, currentPlatform);
        const oldText = settingsManager.readLocalSettings();
        diff.settings = generateSettingsKeyDiff(oldText, filtered.content);
    }

    if (syncOptions.syncSnippets && fileMap['snippets.json'] && !skipByHash.has('snippets.json')) {
        const remoteSnippets = fileMap['snippets.json'].content || '{}';
        const before = settingsManager.readSnippets();
        diff.snippets.changed = hasContentChanged(before, remoteSnippets);
    }

    if (syncOptions.syncExtensions && fileMap['extensions.json'] && !skipByHash.has('extensions.json')) {
        if (trustLevel !== 'untrusted') {
            const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
            const ignoredExtensionIds = new Set(
                normalizeExtensionIds(config.get<string[]>('ignoredExtensions', []))
            );
            const intentionallyRemovedIds = new Set(
                normalizeExtensionIds(context.globalState.get<string[]>(INTENTIONALLY_REMOVED_KEY, []))
            );

            const remoteExtensions = fileMap['extensions.json'].content || '[]';
            const { filteredJson } = await filterExtensionsByMarketplace(remoteExtensions);
            const filteredEntries = parseExtensionList(filteredJson);

            const currentlyInstalled = getInstalledUserExtensionIds();
            for (const entry of filteredEntries) {
                const normalizedId = entry.id.toLowerCase();
                if (ignoredExtensionIds.has(normalizedId)) {
                    continue;
                }
                if (intentionallyRemovedIds.has(normalizedId)) {
                    continue;
                }
                if (!currentlyInstalled.has(normalizedId)) {
                    diff.extensions.toInstall.push(entry.id);
                }
            }

            if (config.get<boolean>('removeExtensions', false)) {
                const remoteIds = new Set(filteredEntries.map(entry => entry.id.toLowerCase()));
                for (const id of currentlyInstalled) {
                    if (id === 'soloboi.solobois-settings-sync') {
                        continue;
                    }
                    if (ignoredExtensionIds.has(id)) {
                        continue;
                    }
                    if (!remoteIds.has(id)) {
                        diff.extensions.toRemove.push(id);
                    }
                }
            }
        }
    }

    return diff;
}

function formatSyncPreviewSummary(diff: SyncDiff, gistId: string, trustLevel: GistTrustLevel): string {
    const parts: string[] = [];

    const settingsCount = diff.settings.added.length + diff.settings.changed.length + diff.settings.removed.length;
    parts.push(
        `Settings: +${diff.settings.added.length} ~${diff.settings.changed.length} -${diff.settings.removed.length}`
            + (settingsCount === 0 ? ' (no changes)' : '')
    );

    const extCount = diff.extensions.toInstall.length + diff.extensions.toRemove.length;
    const extSuffix = trustLevel === 'untrusted' ? ' (blocked: untrusted gist)' : (extCount === 0 ? ' (no changes)' : '');
    parts.push(`Extensions: +${diff.extensions.toInstall.length} -${diff.extensions.toRemove.length}${extSuffix}`);

    parts.push(`Snippets: ${diff.snippets.changed ? 'changed' : 'no changes'}`);

    const trustLabel = trustLevel === 'self' ? 'self' : trustLevel;
    parts.push(`Gist: ${gistId} (trust: ${trustLabel})`);

    return `Sync preview\n\n${parts.join('\n')}\n\nApply downloaded changes?`;
}

function formatRestorePreviewSummary(diff: SyncDiff, sha: string, trustLevel: GistTrustLevel): string {
    const parts: string[] = [];

    const settingsCount = diff.settings.added.length + diff.settings.changed.length + diff.settings.removed.length;
    parts.push(
        `Settings: +${diff.settings.added.length} ~${diff.settings.changed.length} -${diff.settings.removed.length}`
            + (settingsCount === 0 ? ' (no changes)' : '')
    );

    const extCount = diff.extensions.toInstall.length + diff.extensions.toRemove.length;
    const extSuffix = trustLevel === 'untrusted' ? ' (blocked: untrusted gist)' : (extCount === 0 ? ' (no changes)' : '');
    parts.push(`Extensions: +${diff.extensions.toInstall.length} -${diff.extensions.toRemove.length}${extSuffix}`);

    parts.push(`Snippets: ${diff.snippets.changed ? 'changed' : 'no changes'}`);
    parts.push(`Revision: ${sha.substring(0, 7)} (trust: ${trustLevel})`);

    return `Restore preview\n\n${parts.join('\n')}\n\nRestore this revision?`;
}

// ─── Gist 데이터 적용 (Apply Gist Data) ─────────────────────────────────────────────────────────────────────────────

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
    forceOmissionNotice: boolean = false,
    previewConfirmed: boolean = false
): Promise<void> {
    settingsManager.backupCurrentSettings();
    outputChannel.clear();
    outputChannel.appendLine('=== Soloboi\'s Settings Sync download report ===');
    outputChannel.appendLine('');

    const fileMap = (gistData?.files || {}) as Record<string, { content?: string }>;
    const syncOptions = getSyncOptions();
    const antigravityMode = isAntigravityPlatform(currentPlatform);
    const gistId = typeof gistData?.id === 'string' ? gistData.id.trim() : '';
    const trustLevel = gistId ? getGistTrustLevel(gistData, gistId) : 'untrusted';
    const skipByHash = computeHashSkipSet(fileMap, syncOptions, antigravityMode);
    const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
    const ignoredExtensionIds = new Set(
        normalizeExtensionIds(
            config.get<string[]>('ignoredExtensions', [])
        )
    );
    const intentionallyRemovedIds = new Set(
        normalizeExtensionIds(context.globalState.get<string[]>(INTENTIONALLY_REMOVED_KEY, []))
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
        } else if (skipByHash.has('settings.json')) {
            outputChannel.appendLine('  = skipped (hash match)');
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
        } else if (skipByHash.has('keybindings.json')) {
            outputChannel.appendLine('  = skipped (hash match)');
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
        } else if (skipByHash.has('snippets.json')) {
            outputChannel.appendLine('  = skipped (hash match)');
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
        } else if (skipByHash.has('antigravity.json')) {
            antigravityFileLines.push('  = skipped: antigravity.json (hash match)');
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
        } else if (skipByHash.has('browserallowlist.txt')) {
            antigravityFileLines.push('  = skipped: browserAllowlist.txt (hash match)');
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
        } else if (skipByHash.has('extensions.json')) {
            outputChannel.appendLine('  = skipped (hash match)');
            outputChannel.appendLine('');
        } else if (trustLevel === 'untrusted') {
            outputChannel.appendLine('  ! skipped (untrusted gist): extension install/uninstall disabled');
            outputChannel.appendLine('');

            const warningText = gistId
                ? `This gist is untrusted (${gistId}). Extension install/uninstall is blocked. Set soloboisSettingsSync.gistTrust[\"${gistId}\"] = \"trusted\" to enable.`
                : 'This gist is untrusted. Extension install/uninstall is blocked.';
            const actions = gistId ? ['Trust This Gist', 'Open Settings'] : ['Open Settings'];
            vscode.window.showWarningMessage(warningText, ...(actions as any)).then(async selection => {
                if (selection === 'Trust This Gist' && gistId) {
                    const cfg = vscode.workspace.getConfiguration('soloboisSettingsSync');
                    const trustMap = cfg.get<Record<string, string>>('gistTrust', {}) || {};
                    trustMap[gistId] = 'trusted';
                    await cfg.update('gistTrust', trustMap, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage(`Soloboi's Settings Sync: Marked ${gistId} as trusted.`);
                } else if (selection === 'Open Settings') {
                    void vscode.commands.executeCommand('workbench.action.openSettings', 'soloboisSettingsSync.gistTrust');
                }
            });
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

            const { toInstall: unknownToInstall, toIgnore: unknownToIgnore } =
                await promptUnknownExtensionsAction(unknownIds, silent);

            // Permanently ignore user-chosen unknowns
            if (unknownToIgnore.length > 0) {
                const existingIgnored = config.get<string[]>('ignoredExtensions', []);
                const updated = normalizeExtensionIds([...existingIgnored, ...unknownToIgnore]);
                await config.update('ignoredExtensions', updated, vscode.ConfigurationTarget.Global);
                for (const id of unknownToIgnore) {
                    ignoredExtensionIds.add(id.toLowerCase());
                }
            }

            const unknownSet = new Set(normalizeExtensionIds(unknownIds));
            const unknownToInstallSet = new Set(normalizeExtensionIds(unknownToInstall));

            const filteredEntries = parseExtensionList(filteredJson);
            const currentlyInstalled = getInstalledUserExtensionIds();
            const installedNames: string[] = [];
            const alreadyInstalledNames: string[] = [];
            const skippedIgnoredNames: string[] = [];
            const skippedIntentionallyRemovedNames: string[] = [];
            const failedInstallNames: string[] = [];

            const proposedInstalls = filteredEntries
                .filter(entry => {
                    const normalizedId = entry.id.toLowerCase();
                    if (ignoredExtensionIds.has(normalizedId)) {
                        return false;
                    }
                    if (intentionallyRemovedIds.has(normalizedId)) {
                        return false;
                    }
                    if (unknownSet.has(normalizedId)) {
                        return false;
                    }
                    return !currentlyInstalled.has(normalizedId);
                })
                .map(entry => entry.id.toLowerCase());

            // Add user-chosen unknowns to install list
            for (const id of unknownToInstall) {
                const normalizedId = id.toLowerCase();
                if (!ignoredExtensionIds.has(normalizedId) && !proposedInstalls.includes(normalizedId)) {
                    proposedInstalls.push(normalizedId);
                }
            }

            const proposedRemovals: string[] = [];
            if (config.get<boolean>('removeExtensions', false)) {
                const remoteIds = new Set(filteredEntries.map(entry => entry.id.toLowerCase()));
                for (const ext of vscode.extensions.all) {
                    if (ext.packageJSON?.isBuiltin) {
                        continue;
                    }
                    const id = ext.id.toLowerCase();
                    if (id === 'soloboi.solobois-settings-sync') {
                        continue;
                    }
                    if (ignoredExtensionIds.has(id)) {
                        continue;
                    }
                    if (!remoteIds.has(id)) {
                        proposedRemovals.push(ext.id);
                    }
                }
            }

            let applyExtensions = true;

            if (
                !silent &&
                !previewConfirmed &&
                config.get<boolean>('confirmExtensionSync', true) &&
                (proposedInstalls.length > 0 || proposedRemovals.length > 0)
            ) {
                const messageParts: string[] = [];
                if (proposedInstalls.length > 0) {
                    messageParts.push(`Install ${proposedInstalls.length} extension(s)`);
                }
                if (proposedRemovals.length > 0) {
                    messageParts.push(`Remove ${proposedRemovals.length} extension(s)`);
                }

                const selection = await vscode.window.showWarningMessage(
                    `Extension sync will make changes: ${messageParts.join(', ')}.`,
                    { modal: true },
                    'Proceed',
                    'Skip extensions'
                );

                if (selection !== 'Proceed') {
                    outputChannel.appendLine('  ! extension sync skipped by user');
                    outputChannel.appendLine('');
                    applyExtensions = false;
                }
            }

            if (applyExtensions) {
            for (const entry of filteredEntries) {
                const normalizedId = entry.id.toLowerCase();
                const label = extensionLabel(entry);

                if (ignoredExtensionIds.has(normalizedId)) {
                    skippedIgnoredNames.push(label);
                    continue;
                }

                if (intentionallyRemovedIds.has(normalizedId)) {
                    skippedIntentionallyRemovedNames.push(label);
                    continue;
                }

                if (currentlyInstalled.has(normalizedId)) {
                    alreadyInstalledNames.push(label);
                    continue;
                }

                if (unknownSet.has(normalizedId) && !unknownToInstallSet.has(normalizedId)) {
                    continue;
                }
 
                try {
                    await installExtensionViaCLI(entry.id);
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
            // Private extension fallback (Task #3)
            const privateCfg = vscode.workspace.getConfiguration('soloboisSettingsSync');
            const privateExts: any[] = privateCfg.get('privateExtensions', []);
            for (const id of uniqueUnavailable) {
                const label = displayById.get(id) || id;
                const privateEntry = privateExts.find((e: any) => (e.id ?? '').toLowerCase() === id.toLowerCase());
                if (privateEntry?.vsixUrl) {
                    outputChannel.appendLine(`  [private] installing from VSIX URL: ${label}`);
                    try {
                        await installFromVsixUrl(
                            { id: privateEntry.id, currentVersion: '0.0.0', latestVersion: privateEntry.version, marketplaceDomain: '' },
                            outputChannel
                        );
                    } catch (err: any) {
                        outputChannel.appendLine(`  ! private install failed: ${label} — ${err?.message ?? err}`);
                    }
                } else if (privateEntry) {
                    const localPath = getExtensionLocalPath(privateEntry.id, privateEntry.version);
                    outputChannel.appendLine(`  ⚠ ${label} is a private extension — manual install required.`);
                    outputChannel.appendLine(`    Local path hint: ${localPath}`);
                    if (privateEntry.note) {
                        outputChannel.appendLine(`    Note: ${privateEntry.note}`);
                    }
                } else {
                    outputChannel.appendLine(`  ! skipped (not found in marketplace): ${label}`);
                    outputChannel.appendLine(`    Tip: Run "Register Private Extension" to add sync support for this extension.`);
                }
            }

            const uniqueUnknown = uniqueList(unknownIds);
            for (const id of uniqueUnknown) {
                const label = displayById.get(id) || id;
                if (currentlyInstalled.has(id)) {
                    outputChannel.appendLine(`  = marketplace check unknown (already installed): ${label}`);
                } else if (ignoredExtensionIds.has(id)) {
                    outputChannel.appendLine(`  ! marketplace check unknown (ignored): ${label}`);
                } else if (unknownToInstallSet.has(id)) {
                    outputChannel.appendLine(`  ! marketplace check unknown (install requested): ${label}`);
                } else {
                    outputChannel.appendLine(`  ! marketplace check unknown (skipped): ${label}`);
                }
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
            for (const name of skippedIntentionallyRemovedNames) {
                outputChannel.appendLine(`  ~ skipped (intentionally removed): ${name}`);
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
                skippedIntentionallyRemovedNames.length === 0 &&
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
    }

    if (!hasChanges) {
        outputChannel.appendLine('No local changes were applied.');
    }

    const now = new Date().toISOString();
    await markStateSynchronized(context, now);
    updateStatusBar('idle');

    const uniqueSkippedKeys = uniqueList(omissionSummary.skippedSettingKeys);
    const uniqueSkippedFiles = uniqueList(omissionSummary.skippedAntigravityFiles);
    const hasOmissions = uniqueSkippedKeys.length > 0 || uniqueSkippedFiles.length > 0;

    if (hasOmissions) {
        outputChannel.appendLine('[Cross-platform note] Some Antigravity-specific items were skipped.');
        outputChannel.appendLine('  - VS Code cannot apply Antigravity-only settings and files directly.');
        outputChannel.appendLine('  - Review the skipped items below if you need to recreate them manually.');
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
            parts.push(`antigravity.* settings ${uniqueSkippedKeys.length}`);
        }
        if (uniqueSkippedFiles.length > 0) {
            parts.push(`Antigravity-only files ${uniqueSkippedFiles.length}`);
        }

        const summary = parts.length > 0 ? parts.join(', ') : 'cross-platform settings';
        vscode.window.showWarningMessage(
            `Some Antigravity-specific items were skipped during sync. (${summary}) See the report for details.`,
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

        const items: (vscode.QuickPickItem & { version: string })[] = history.map((h: any) => {
            const additions = h.change_status?.additions || 0;
            const deletions = h.change_status?.deletions || 0;
            const changeLabel = additions + deletions === 0
                ? 'no file changes'
                : `+${additions} / -${deletions} lines`;
            return {
                label: `$(git-commit) ${new Date(h.committed_at).toLocaleString()}`,
                description: h.version.substring(0, 7),
                detail: changeLabel,
                version: h.version
            };
        });

        updateStatusBar('idle');
        const selected = await vscode.window.showQuickPick(items, {
            title: 'Select a Gist revision to restore',
            placeHolder: 'Choose a previous settings version'
        });

        if (selected) {
            const sha = selected.version;
            updateStatusBar('downloading');
            const gistData = await gistService.getGistRevision(gistId, sha, token);

            // Restore Preview (Item 12) — compute semantic diff before applying
            const trustLevel = getGistTrustLevel(gistData, gistId);
            const diff = await computeSyncDiff(gistData, context, gistId, trustLevel);
            const summary = formatRestorePreviewSummary(diff, sha, trustLevel);
            const choice = await vscode.window.showInformationMessage(
                summary,
                { modal: true },
                'Restore',
                'Cancel'
            );

            if (choice !== 'Restore') {
                updateStatusBar('idle');
                return;
            }

            await applyGistData(gistData, context, false, true, true);
            updateStatusBar('idle');
            vscode.window.showInformationMessage("Soloboi's Settings Sync: Restored selected revision.");
        }
    } catch (err: any) {
        vscode.window.showErrorMessage(`Soloboi's Settings Sync: Failed to load history: ${err.message}`);
        updateStatusBar('error');
    }
}

// ─── 도우미 함수 (Helpers) ──────────────────────────────────────────────────────────────────────────────────

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
        const baseFiles = (files || buildGistFiles()) as Record<string, { content: string }> | null;
        if (!baseFiles) {
            throw new Error('No sync files were generated.');
        }
        const result = await gistService.createGist(description, withSyncMetadataFiles(baseFiles), token, isPublic);
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
    const isPublicGist = config.get<boolean>('publicGist', false);

    const settings = settingsManager.readLocalSettings();
    const keybindings = settingsManager.readLocalKeybindings();
    const extensions = settingsManager.readInstalledExtensions();
    const antigravityConfig = settingsManager.readAntigravityConfig();
    const browserAllowlist = settingsManager.readBrowserAllowlist();
    const snippets = settingsManager.readSnippets();

    const files: Record<string, { content: string }> = {};

    if (syncOptions.syncSettings && settings) {
        const filtered = filterSettingsByPlatform(settings, currentPlatform);
        const sanitizedSettings = isPublicGist
            ? settingsManager.sanitizeJsonForPublicGist(filtered.content)
            : filtered.content;
        files['settings.json'] = { content: sanitizedSettings };
    }

    if (syncOptions.syncKeybindings) {
        const sanitizedKeybindings = isPublicGist
            ? sensitiveDataGuard.redactJsonString(keybindings, 'public').result
            : sensitiveDataGuard.redactJsonString(keybindings, 'private').result;
        files['keybindings.json'] = { content: sanitizedKeybindings };
    }

    if (syncOptions.syncExtensions) {
        // extensions always available (may be empty list)
        files['extensions.json'] = { content: extensions };
    }

    if (!isPublicGist && syncOptions.syncAntigravityConfig && isAntigravityPlatform(currentPlatform) && antigravityConfig) {
        files['antigravity.json'] = { content: antigravityConfig };
    }
    if (!isPublicGist && syncOptions.syncAntigravityConfig && isAntigravityPlatform(currentPlatform) && browserAllowlist) {
        files['browserAllowlist.txt'] = { content: browserAllowlist };
    }
    if (syncOptions.syncSnippets && snippets) {
        try {
            const parsedSnippets = JSON.parse(snippets) as Record<string, string>;
            const sanitizedSnippets: Record<string, string> = {};

            for (const [name, content] of Object.entries(parsedSnippets)) {
                const sanitizedSnippet = isPublicGist
                    ? sensitiveDataGuard.redactJsonString(content, 'public').result
                    : sensitiveDataGuard.redactJsonString(content, 'private').result;
                sanitizedSnippets[name] = sanitizedSnippet;
            }

            files['snippets.json'] = { content: JSON.stringify(sanitizedSnippets, null, 2) };
        } catch {
            const fallbackSanitizedSnippets = isPublicGist
                ? sensitiveDataGuard.redactJsonString(snippets, 'public').result
                : sensitiveDataGuard.redactJsonString(snippets, 'private').result;
            files['snippets.json'] = { content: fallbackSanitizedSnippets };
        }
    }

    if (Object.keys(files).length === 0) {
        return null;
    }
    return files;
}

type SyncIndex = {
    changedPaths: string[];
    extensionActions: {
        toInstall: string[];
        toRemove: string[];
    };
};

function computeExtensionActions(oldListStr: string | null | undefined, newListStr: string | null | undefined): { toInstall: string[]; toRemove: string[] } {
    const toInstall: string[] = [];
    const toRemove: string[] = [];

    try {
        const oldList = oldListStr ? JSON.parse(oldListStr) : [];
        const newList = newListStr ? JSON.parse(newListStr) : [];
        const oldIds = new Set((Array.isArray(oldList) ? oldList : []).map((e: any) => String(e?.id || '').toLowerCase()).filter(Boolean));
        const newIds = new Set((Array.isArray(newList) ? newList : []).map((e: any) => String(e?.id || '').toLowerCase()).filter(Boolean));

        for (const id of newIds) {
            if (!oldIds.has(id)) {
                toInstall.push(id);
            }
        }
        for (const id of oldIds) {
            if (!newIds.has(id)) {
                toRemove.push(id);
            }
        }
    } catch {
        // ignore
    }

    return { toInstall, toRemove };
}

function withSyncMetadataFiles(
    baseFiles: Record<string, { content: string }>,
    currentFiles?: Record<string, { filename: string; content: string }>
): Record<string, { content: string }> {
    const changedPaths: string[] = [];

    if (!currentFiles) {
        changedPaths.push(...Object.keys(baseFiles));
    } else {
        for (const [filename, file] of Object.entries(baseFiles)) {
            const previous = currentFiles[filename]?.content;
            if (!previous) {
                changedPaths.push(filename);
                continue;
            }
            if (sha256(previous) !== sha256(file.content)) {
                changedPaths.push(filename);
            }
        }
    }

    const extensionActions = computeExtensionActions(
        currentFiles?.['extensions.json']?.content,
        baseFiles['extensions.json']?.content
    );

    const index: SyncIndex = {
        changedPaths: uniqueList(changedPaths),
        extensionActions
    };
    const indexContent = JSON.stringify(index, null, 2);

    const files: Record<string, { content: string }> = { ...baseFiles };
    files['sync-index.json'] = { content: indexContent };

    const hashes: Record<string, string> = {};
    for (const [filename, file] of Object.entries(files)) {
        if (filename.toLowerCase() === 'sync-manifest.json') {
            continue;
        }
        hashes[filename] = sha256(file.content);
    }

    const manifest: SyncManifest = {
        version: 1,
        timestamp: new Date().toISOString(),
        hashes,
        changedFiles: uniqueList([...index.changedPaths, 'sync-index.json', 'sync-manifest.json'])
    };
    files['sync-manifest.json'] = { content: JSON.stringify(manifest, null, 2) };

    return files;
}

function isManagedGistFile(filename: string): boolean {
    const normalized = filename.toLowerCase();
    return normalized === 'settings.json'
        || normalized === 'keybindings.json'
        || normalized === 'extensions.json'
        || normalized === 'snippets.json'
        || normalized === 'sync-manifest.json'
        || normalized === 'sync-index.json'
        || normalized === 'mcp_config.json'
        || normalized === 'browserallowlist.txt'
        || /^antigravity.*\.json$/i.test(filename)
        || /\.code-snippets$/i.test(filename);
}

function getManagedGistFilesToDelete(
    currentFiles: Record<string, { filename: string; content: string }> | undefined,
    nextFiles: Record<string, { content: string }>
): string[] {
    const nextFileNames = new Set(Object.keys(nextFiles).map(name => name.toLowerCase()));

    return Object.values(currentFiles || {})
        .map(file => file?.filename || '')
        .filter(filename => !!filename)
        .filter(filename => isManagedGistFile(filename))
        .filter(filename => !nextFileNames.has(filename.toLowerCase()));
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

// ── VSIX installer helper (Task #2) ────────────────────────────────────────

/**
 * Downloads a VSIX from the given URL to a temp file, installs it via VS Code's
 * extension API, then cleans up the temp file.
 */
async function installFromVsixUrl(
    upd: ExtensionUpdateInfo,
    log: vscode.OutputChannel
): Promise<void> {
    const registry = marketplaceManager.getRegistry();
    const baseUrl = registry[upd.marketplaceDomain];
    if (!baseUrl) {
        log.appendLine(`[VSIX Install] No URL found for marketplace "${upd.marketplaceDomain}" — skipping ${upd.id}`);
        return;
    }

    // Build VSIX URL: OpenVSX convention — /api/{ns}/{name}/{version}/file/{ns}.{name}-{version}.vsix
    const parts = upd.id.split('.');
    if (parts.length < 2) { return; }
    const ns = parts[0];
    const name = parts.slice(1).join('.');
    const vsixFile = `${ns}.${name}-${upd.latestVersion}.vsix`;
    const vsixUrl = `${baseUrl.replace(/\/$/, '')}/api/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/${encodeURIComponent(upd.latestVersion)}/file/${vsixFile}`;

    const tmpPath = path.join(os.tmpdir(), `soloboi-sync-${vsixFile}`);
    log.appendLine(`[VSIX Install] Downloading ${upd.id}@${upd.latestVersion} from ${upd.marketplaceDomain}...`);

    try {
        await downloadFile(vsixUrl, tmpPath);
        await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(tmpPath));
        log.appendLine(`[VSIX Install] Installed ${upd.id}@${upd.latestVersion}`);
    } finally {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup errors */ }
    }
}

function downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const transport = parsed.protocol === 'http:' ? require('http') : require('https');
        const file = fs.createWriteStream(destPath);

        const req = transport.get(url, (res: any) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                file.close();
                fs.unlinkSync(destPath);
                downloadFile(res.headers.location, destPath).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                file.close();
                reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
                return;
            }
            res.pipe(file);
            file.on('finish', () => file.close(() => resolve()));
        });

        req.on('error', (err: Error) => {
            file.close();
            try { fs.unlinkSync(destPath); } catch { /* ignore */ }
            reject(err);
        });
    });
}

// ── Private extension path helper (Task #3) ────────────────────────────────

function getExtensionLocalPath(id: string, version: string): string {
    const extDir = path.join(os.homedir(), '.vscode', 'extensions');
    return path.join(extDir, `${id.toLowerCase()}-${version}`);
}
