import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as os from 'os';
import { AuthManager } from './auth';
import { GistData, GistService } from './gistService';
import { SettingsManager } from './settingsManager';
import { SoloboiSyncTreeProvider } from './treeProvider';
import { AutoUploadController } from './sync/autoUpload';
import { detectPlatform, Platform } from './platformDetector';
import {
    applyGistData,
    buildExtensionContributionMap,
    buildGistFiles,
    computeSyncDiff,
    downloadSettings,
    ensureLoggedIn,
    filterExtensionsByMarketplace,
    fullSync,
    openSyncDiffPanels,
    setupFileWatchers,
    shouldDownloadRemoteOnStartup,
    showGistHistory,
    uploadSettings,
    withSyncMetadataFiles
} from './sync/coreSyncService';
import { registerPrototypeCommands } from './prototypeCommands';
import { registerPrivateExtCommands } from './commands/privateExtCommands';
import { registerConfigCommands } from './commands/configCommands';
import { registerUtilCommands } from './commands/utilCommands';
import { registerAuthCommands } from './commands/authCommands';
import { registerGistCommands } from './commands/gistCommands';
import { registerProfileCommands } from './commands/profileCommands';
import { registerSyncCommands } from './commands/syncCommands';
import { StatusBarController } from './ui/statusBar';
import { runGettingStartedWizard } from './ui/gettingStarted';
import type { OmissionSummary, GistTrustLevel, SyncDiff, SyncOptions, SyncManifest, RemoteExtensionEntry, SyncIndex } from './types';
import type { AppContext } from './context';
import { GIST_DESCRIPTION_PREFIX, GIST_DEFAULT_DESCRIPTION, LAST_SYNC_KEY, PENDING_UPLOAD_KEY, INTENTIONALLY_REMOVED_KEY, AUTO_UPLOAD_SUPPRESSION_BUFFER_MS, EXTENSION_CHANGE_UPLOAD_DELAY_MS } from './constants';
import { toErrorMessage, normalizeIgnoredSettings, normalizeExtensionIds, parseJsonc, parseTimestamp } from './utils';
import { computeExtensionActions, extensionLabel, formatRestorePreviewSummary, formatSyncPreviewSummary, generateExtensionsDiff, generateSettingsDiff, generateSettingsKeyDiff, getGistTrustLevel, getManagedGistFilesToDelete, hasContentChanged, isManagedGistFile, parseExtensionList, readSyncManifest, sha256, uniqueList } from './sync/syncEngine';
import {
    applyProfileToGlobalSettings,
    cleanupIgnoredExtensions,
    configureProfileManager,
    getCurrentProfileName,
    getInstalledUserExtensionIds,
    getManagedExtensionsSnapshot,
    getPendingUploadState,
    initializeProfiles,
    markLocalStateChanged,
    markStateSynchronized,
    parseExtensionIds,
    pruneIntentionallyRemovedExtensions,
    saveCurrentProfileFromGlobal,
    selectOrCreateGist
} from './sync/profileManager';

let authManager: AuthManager;
let gistService: GistService;

/** Content store for virtual diff documents (soloboi-diff: scheme). */
const diffDocumentStore = new Map<string, string>();
let settingsManager: SettingsManager;
let fileWatcher: vscode.FileSystemWatcher | undefined;
let appCtx: AppContext | undefined;
let outputChannel: vscode.OutputChannel;
let logChannel: vscode.OutputChannel;
let lastSyncTime: string | null = null;
let currentPlatform: Platform = 'unknown';
let updateStatusBar: (state: 'idle' | 'uploading' | 'downloading' | 'error' | 'logged-out', detail?: string) => void = () => undefined;

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
    const statusBarController = new StatusBarController();
    context.subscriptions.push(statusBarController);
    updateStatusBar = (state: 'idle' | 'uploading' | 'downloading' | 'error' | 'logged-out', detail?: string) =>
        statusBarController.update(state, detail ?? (state === 'idle' ? lastSyncTime ?? undefined : undefined));
    updateStatusBar('idle');
    statusBarController.show();
    configureProfileManager({
        gistService,
        settingsManager,
        updateStatusBar,
        setLastSyncTime: (timestamp) => {
            lastSyncTime = timestamp;
        },
        buildGistFiles: () => (appCtx ? buildGistFiles(appCtx) : null),
        withSyncMetadataFiles
    });

    // Output channels
    outputChannel = vscode.window.createOutputChannel("Soloboi's Settings Sync");
    context.subscriptions.push(outputChannel);
    const autoUploadController = new AutoUploadController(outputChannel);
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
    const isAutoUploadBlocked = () =>
        autoUploadController.isSuspended();
    let extensionSnapshot = getManagedExtensionsSnapshot();
    let extensionContributionMap = buildExtensionContributionMap();
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
                    const removedSettingKeys = normalizeIgnoredSettings(
                        removed.flatMap(id => extensionContributionMap.get(id) || [])
                    );
                    if (removedSettingKeys.length > 0) {
                        const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
                        const existingIgnored = config.get<string[]>('ignoredSettings', []);
                        const mergedIgnored = normalizeIgnoredSettings([...existingIgnored, ...removedSettingKeys]);
                        if (JSON.stringify(existingIgnored) !== JSON.stringify(mergedIgnored)) {
                            await config.update(
                                'ignoredSettings',
                                mergedIgnored,
                                vscode.ConfigurationTarget.Global
                            );
                            await saveCurrentProfileFromGlobal(config);
                        }
                        outputChannel.appendLine(
                            `[Auto-ignore] Removed extensions contributed ${removedSettingKeys.length} setting(s): ${removedSettingKeys.slice(0, 3).join(', ')}${removedSettingKeys.length > 3 ? ' ...' : ''}`
                        );
                    }

                    for (const removedId of removed) {
                        outputChannel.appendLine(
                            `[Auto-ignore] ${removedId} removal detected.`
                        );
                    }
                }
            }

            extensionSnapshot = nextSnapshot;
            extensionContributionMap = buildExtensionContributionMap();

            await cleanupIgnoredExtensions();

            if (!extensionsChanged || isAutoUploadBlocked()) {
                return;
            }

            const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
            if (!config.get<boolean>('autoSync', false) || !config.get<boolean>('autoUploadOnChange', true)) {
                return;
            }

            await markLocalStateChanged(context, 'extension list changed');
            autoUploadController.schedule(
                context,
                config,
                'extension list changed',
                gistService,
                authManager,
                outputChannel,
                treeProvider,
                updateStatusBar,
                async () => {
                    await uploadSettings(ctx, context, true);
                },
                EXTENSION_CHANGE_UPLOAD_DELAY_MS
            );
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

    const ctx: AppContext = {
        extensionContext: context,
        outputChannel,
        logChannel,
        gistService,
        authManager,
        platform: currentPlatform,
        settingsManager,
        treeProvider,
        autoUploadController,
        statusBarController,
        updateStatusBar,
        diffDocumentStore,
    };
    appCtx = ctx;


    registerAuthCommands(context, ctx);
    registerSyncCommands(context, ctx);
    registerProfileCommands(context, ctx);
    registerGistCommands(context, ctx);
    registerConfigCommands(context, ctx);
    registerPrivateExtCommands(context, ctx);


    registerUtilCommands(context, ctx);

    registerPrototypeCommands(context, {
        settingsManager,
        outputChannel
    });


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
                await runGettingStartedWizard(context, authManager?.isLoggedIn() ?? false);
            } else if (selection === 'Later') {
                await context.globalState.update('setupPrompted', true);
            }
        });
    }


    // Delay to let VS Code finish initialising before the startup sync.
    // A fixed delay is used because there is no reliable VS Code event that fires
    // after all extensions are fully activated in all environments (local, remote, container).
    const STARTUP_SYNC_DELAY_MS = 3000;

    if (config.get<boolean>('autoSync', false) && config.get<boolean>('autoSyncOnStartup')) {
        setTimeout(async () => {
            const session = await authManager.getSessionSilent();
            if (session) {
                if (await shouldDownloadRemoteOnStartup(ctx, context)) {
                    await downloadSettings(ctx, context, autoUploadController, true);
                }
            }
        }, STARTUP_SYNC_DELAY_MS);
    }


    setupFileWatchers(ctx, context, autoUploadController, treeProvider);
}


export function deactivate(): Thenable<void> | undefined {
    // Upload current settings on exit
    if (authManager?.isLoggedIn()) {
        // We can't fully await here, but we return the promise so VS Code waits
        return (async () => {
            try {
                const token = await authManager.getToken();
                if (!token) { return; }
                const baseFiles = appCtx ? buildGistFiles(appCtx) : null;
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




