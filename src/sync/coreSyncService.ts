import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { sensitiveDataGuard } from '../sensitiveDataGuard';
import { GIST_DESCRIPTION_PREFIX, PENDING_UPLOAD_KEY } from '../constants';
import { toErrorMessage, parseTimestamp } from '../utils';
import { computeExtensionActions, formatRestorePreviewSummary, getGistTrustLevel, getManagedGistFilesToDelete, parseExtensionList, sha256, uniqueList } from './syncEngine';
import { getInstalledUserExtensionIds, getPendingUploadState, markLocalStateChanged, markStateSynchronized, pruneIntentionallyRemovedExtensions, selectOrCreateGist } from './profileManager';
import type { SyncManifest, SyncIndex, RemoteExtensionEntry } from '../types';
import type { Platform } from '../platformDetector';
import type { AppContext } from '../context';
import { AutoUploadController } from './autoUpload';
import { GistData } from '../gistService';
import { SoloboiSyncTreeProvider } from '../treeProvider';
import {
    isAntigravityPlatform,
    getSyncOptions,
    filterSettingsByPlatform,
    filterExtensionsByMarketplace,
    promptUnknownExtensionsAction,
    getLocalComparableContent,
    computeHashSkipSet,
    computeSyncDiff,
    getExtensionContributedSettingKeys,
    buildExtensionContributionMap,
    installExtensionViaCLI
} from './helpers';
import { reviewFilesForSensitiveUpload } from './uploadPrivacyReview';
export { applyGistData } from './applyData';
import { applyGistData } from './applyData';
export {
    isAntigravityPlatform,
    getSyncOptions,
    filterSettingsByPlatform,
    filterExtensionsByMarketplace,
    promptUnknownExtensionsAction,
    getLocalComparableContent,
    computeHashSkipSet,
    computeSyncDiff,
    getExtensionContributedSettingKeys,
    buildExtensionContributionMap,
    installExtensionViaCLI
} from './helpers';

let fileWatcher: vscode.FileSystemWatcher | undefined;
let activeWatchers: vscode.FileSystemWatcher[] = [];
let isUploading = false;
let isDownloading = false;
let isApplyingRemoteChanges = false;
let outputChannel: vscode.OutputChannel;
let logChannel: vscode.OutputChannel | undefined;
let currentPlatform: Platform = 'unknown';
let updateStatusBar: AppContext['updateStatusBar'] = () => undefined;
let gistService: AppContext['gistService'];
let authManager: AppContext['authManager'];
let settingsManager: AppContext['settingsManager'];
let diffDocumentStore: AppContext['diffDocumentStore'];

function bindCtx(ctx: AppContext): void {
  outputChannel = ctx.outputChannel;
  logChannel = ctx.logChannel;
  currentPlatform = ctx.platform;
  updateStatusBar = ctx.updateStatusBar;
  gistService = ctx.gistService;
  authManager = ctx.authManager;
  settingsManager = ctx.settingsManager;
  diffDocumentStore = ctx.diffDocumentStore;
}

function logLine(level: 'INFO' | 'WARN' | 'ERROR', message: string, err?: unknown): void {
  const ts = new Date().toISOString();
  const suffix = err ? ` | ${toErrorMessage(err)}` : '';
  logChannel?.appendLine(`[${ts}] ${level} ${message}${suffix}`);
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

export async function shouldDownloadRemoteOnStartup(ctx: AppContext, context: vscode.ExtensionContext
): Promise<boolean> {
    bindCtx(ctx);
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

    const uploaded = await uploadSettings(ctx, context, true);
    if (!uploaded) {
        outputChannel.appendLine(
            'Pending local changes could not be uploaded during startup. Remote download remains skipped to avoid overwriting local state.'
        );
    }

    return false;
}

export async function uploadSettings(ctx: AppContext, context: vscode.ExtensionContext,
    silent: boolean = false
): Promise<boolean> {
    bindCtx(ctx);
    if (isUploading || isDownloading || isApplyingRemoteChanges) {
        return false;
    }
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

        const baseFiles = buildGistFiles(ctx);
        if (!baseFiles) {
            if (!silent) {
                vscode.window.showErrorMessage("Soloboi's Settings Sync: No sync files were generated.");
            }
            logError('Upload failed: no sync files were generated.');
            return false;
        }

        const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
        const isPublicGist = config.get<boolean>('publicGist', false);
        const privacyReviewed = await reviewFilesForSensitiveUpload(baseFiles, {
            isPublicGist,
            silent,
            outputChannel
        });
        if (privacyReviewed.cancelled) {
            if (!silent) {
                vscode.window.showWarningMessage("Soloboi's Settings Sync: Upload cancelled by privacy review.");
            }
            updateStatusBar('idle');
            logWarn('Upload cancelled by privacy review.');
            return false;
        }
        const reviewedFiles = privacyReviewed.files;

        const filesForCreate = withSyncMetadataFiles(reviewedFiles);
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
        const files = withSyncMetadataFiles(reviewedFiles, currentGist?.files);
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
                logChannel?.show(true);
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
                    logChannel?.show(true);
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

export async function openSyncDiffPanels(ctx: AppContext, gistData: GistData): Promise<void> {
    bindCtx(ctx);
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
            `${file.filename}  Remote (Gist) ??Local`,
            { preview: filesToDiff.length === 1 }
        );
    }
}

export async function downloadSettings(ctx: AppContext, context: vscode.ExtensionContext,
    autoUploadController: AutoUploadController,
    silent: boolean = false,
    forceOmissionNotice: boolean = false
): Promise<boolean> {
    bindCtx(ctx);
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
        const suppressionWindow = autoUploadController.getSuppressionWindow(config);

        if (!gistId) {
            if (silent) {
                return false;
            }

            const baseFiles = buildGistFiles(ctx);
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
            const trustLevel = getGistTrustLevel(gistData, gistId, {
                accountLabel: authManager.getAccountLabel(),
                trustMap: config.get<Record<string, string>>('gistTrust', {}) || {}
            });
            const diff = await computeSyncDiff(ctx, gistData, context, gistId, trustLevel);
            await openSyncDiffPanels(ctx, gistData);
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

        autoUploadController.suspend(suppressionWindow);
        isApplyingRemoteChanges = true;
        try {
            await applyGistData(ctx, gistData, context, silent, forceOmissionNotice, previewConfirmed);
        } finally {
            isApplyingRemoteChanges = false;
            autoUploadController.suspend(suppressionWindow);
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
                logChannel?.show(true);
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
                    logChannel?.show(true);
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

export async function fullSync(ctx: AppContext, context: vscode.ExtensionContext,
    autoUploadController: AutoUploadController
): Promise<void> {
    bindCtx(ctx);
    const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
    const gistId = config.get<string>('gistId');

    if (gistId) {
        const downloaded = await downloadSettings(ctx, context, autoUploadController, true, true);
        if (!downloaded) {
            logWarn('Full sync aborted: download step failed (upload skipped).');
            vscode.window.showWarningMessage(
                "Soloboi's Settings Sync: Download step failed. Upload skipped to avoid overwriting remote settings."
            );
            return;
        }
        await uploadSettings(ctx, context, false);
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
                logChannel?.show(true);
            }
        });
    } else {
        await uploadSettings(ctx, context, false);
    }
}

export function setupFileWatchers(ctx: AppContext, context: vscode.ExtensionContext,
    autoUploadController: AutoUploadController,
    treeProvider: SoloboiSyncTreeProvider
): void {
    bindCtx(ctx);

    for (const watcher of activeWatchers) {
        watcher.dispose();
    }
    activeWatchers = [];

    const settingsDir = settingsManager.getUserSettingsDir();
    if (!settingsDir) {
        return;
    }

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

    const additionalFileWatchers: vscode.FileSystemWatcher[] = [];
    for (const additionalFilePath of settingsManager.getConfiguredAdditionalFilePaths()) {
        const dirname = path.dirname(additionalFilePath);
        const basename = path.basename(additionalFilePath);
        if (!dirname || !basename) {
            continue;
        }
        const additionalPattern = new vscode.RelativePattern(
            vscode.Uri.file(dirname),
            basename
        );
        additionalFileWatchers.push(vscode.workspace.createFileSystemWatcher(additionalPattern));
    }

    const scheduleUpload = async (reason: string) => {
        if (isDownloading || isApplyingRemoteChanges || autoUploadController.isSuspended()) {
            return;
        }

        await markLocalStateChanged(context, reason);
        autoUploadController.schedule(
            context,
            config,
            reason,
            gistService,
            authManager,
            outputChannel,
            treeProvider,
            updateStatusBar,
            async () => {
                await uploadSettings(ctx, context, true);
            },
            delay
        );
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
    activeWatchers.push(fileWatcher);

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
        activeWatchers.push(snippetsWatcher);
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
        activeWatchers.push(antigravityWatcher);
    }

    for (const additionalWatcher of additionalFileWatchers) {
        additionalWatcher.onDidChange(() => {
            void scheduleUpload('additional file changed');
        });
        additionalWatcher.onDidCreate(() => {
            void scheduleUpload('additional file created');
        });
        additionalWatcher.onDidDelete(() => {
            void scheduleUpload('additional file deleted');
        });
        context.subscriptions.push(additionalWatcher);
        activeWatchers.push(additionalWatcher);
    }
}


export async function showGistHistory(ctx: AppContext, context: vscode.ExtensionContext): Promise<void> {
    bindCtx(ctx);
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

            // Restore Preview (Item 12) ??compute semantic diff before applying
            const trustLevel = getGistTrustLevel(gistData, gistId, {
                accountLabel: authManager.getAccountLabel(),
                trustMap: config.get<Record<string, string>>('gistTrust', {}) || {}
            });
            const diff = await computeSyncDiff(ctx, gistData, context, gistId, trustLevel);
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

            await applyGistData(ctx, gistData, context, false, true, true);
            updateStatusBar('idle');
            vscode.window.showInformationMessage("Soloboi's Settings Sync: Restored selected revision.");
        }
    } catch (err: any) {
        vscode.window.showErrorMessage(`Soloboi's Settings Sync: Failed to load history: ${err.message}`);
        updateStatusBar('error');
    }
}

export function buildGistFiles(ctx: AppContext): Record<string, { content: string }> | null {
    bindCtx(ctx);
    const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
    const syncOptions = getSyncOptions(ctx, config);
    const isPublicGist = config.get<boolean>('publicGist', false);

    const settings = settingsManager.readLocalSettings();
    const keybindings = settingsManager.readLocalKeybindings();
    const extensions = settingsManager.readInstalledExtensions();
    const antigravityConfig = settingsManager.readAntigravityConfig();
    const browserAllowlist = settingsManager.readBrowserAllowlist();
    const snippets = settingsManager.readSnippets();

    const files: Record<string, { content: string }> = {};

    if (syncOptions.syncSettings && settings) {
    bindCtx(ctx);
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

    // Additional user-configured files (e.g. eclipse-formatter.xml)
    const additionalFiles = settingsManager.readAdditionalFiles();
    for (const [key, content] of Object.entries(additionalFiles)) {
        const sanitizedContent = isPublicGist
            ? sensitiveDataGuard.redactJsonString(content, 'public').result
            : content;
        files[key] = { content: sanitizedContent };
    }

    if (Object.keys(files).length === 0) {
        return null;
    }
    return files;
}

export function withSyncMetadataFiles(
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

export async function ensureLoggedIn(ctx: AppContext): Promise<void> {
    bindCtx(ctx);
    const session = await authManager.getSessionSilent();
    if (!session) {
        await authManager.login();
    }
}

