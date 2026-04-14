import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
    getAutoDetectOptions,
    getSafePrivateExtensions,
    mergeDetectedPrivateExtension,
    normalizePrivateExtensionId,
    type PrivateExtensionEntry
} from '../privateExtensions/registry';
import { getExtensionLocalPath, installFromVsixUrl } from '../privateExtensions/vsixInstaller';
import { INTENTIONALLY_REMOVED_KEY } from '../constants';
import { toErrorMessage, normalizeExtensionIds } from '../utils';
import {
    extensionLabel,
    generateExtensionsDiff,
    generateSettingsDiff,
    getGistTrustLevel,
    hasContentChanged,
    parseExtensionList,
    uniqueList
} from './syncEngine';
import { getInstalledUserExtensionIds, markStateSynchronized } from './profileManager';
import type { OmissionSummary } from '../types';
import type { AppContext } from '../context';
import {
    filterSettingsByPlatform,
    filterExtensionsByMarketplace,
    promptUnknownExtensionsAction,
    computeHashSkipSet,
    getSyncOptions,
    isAntigravityPlatform,
    installExtensionViaCLI
} from './helpers';

export async function applyGistData(
    ctx: AppContext,
    gistData: any,
    context: vscode.ExtensionContext,
    silent: boolean = false,
    forceOmissionNotice: boolean = false,
    previewConfirmed: boolean = false
): Promise<void> {
    const { settingsManager, outputChannel, gistService, authManager } = ctx;

    settingsManager.backupCurrentSettings();
    outputChannel.clear();
    outputChannel.appendLine("=== Soloboi's Settings Sync download report ===");
    outputChannel.appendLine('');

    const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
    const fileMap = (gistData?.files || {}) as Record<string, { content?: string }>;
    const syncOptions = getSyncOptions(ctx);
    const antigravityMode = isAntigravityPlatform(ctx.platform);
    const gistId = typeof gistData?.id === 'string' ? gistData.id.trim() : '';
    const trustLevel = gistId
        ? getGistTrustLevel(gistData, gistId, {
            accountLabel: authManager.getAccountLabel(),
            trustMap: config.get<Record<string, string>>('gistTrust', {}) || {}
        })
        : 'untrusted';
    const skipByHash = computeHashSkipSet(ctx, fileMap, syncOptions, antigravityMode);
    const ignoredExtensionIds = new Set(
        normalizeExtensionIds(
            config.get<string[]>('ignoredExtensions', [])
        )
    );
    const intentionallyRemovedIds = new Set(
        normalizeExtensionIds(context.globalState.get<string[]>(INTENTIONALLY_REMOVED_KEY, []))
    );

    outputChannel.appendLine(`[Platform] ${ctx.platform}`);
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
            const filtered = filterSettingsByPlatform(remoteSettings, ctx.platform);
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
    if (!fileMap['antigravity.json'] && fileMap['mcp_config.json']) {
        if (!syncOptions.syncAntigravityConfig) {
            antigravityFileLines.push('  ! skipped: mcp_config.json (syncAntigravityConfig=false)');
        } else if (!antigravityMode) {
            antigravityFileLines.push('  ! skipped: mcp_config.json (platform mismatch)');
            omissionSummary.skippedAntigravityFiles.push('mcp_config.json');
        } else if (skipByHash.has('antigravity.json') || skipByHash.has('mcp_config.json')) {
            antigravityFileLines.push('  = skipped: mcp_config.json (hash match)');
        } else {
            const remoteConfig = fileMap['mcp_config.json'].content || '{}';
            const before = settingsManager.readAntigravityConfig();
            if (hasContentChanged(before, remoteConfig)) {
                hasChanges = true;
            }
            settingsManager.writeAntigravityConfig(remoteConfig);
            antigravityFileLines.push('  + applied: mcp_config.json');
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

    const additionalKeys = Object.keys(fileMap).filter(k => k.startsWith('additional__'));
    if (additionalKeys.length > 0) {
        if (trustLevel === 'untrusted') {
            outputChannel.appendLine('[Additional Files]');
            outputChannel.appendLine('  ! skipped (untrusted gist)');
            outputChannel.appendLine('');
        } else {
            outputChannel.appendLine('[Additional Files]');
            for (const key of additionalKeys) {
                const fileEntry = fileMap[key] as { content?: string } | null | undefined;
                if (!fileEntry) {
                    continue;
                }

                const content = fileEntry.content || '';
                try {
                    const changed = settingsManager.writeAdditionalFile(key, content);
                    if (changed) {
                        outputChannel.appendLine(`  + applied: ${key}`);
                        hasChanges = true;
                    } else {
                        outputChannel.appendLine(`  = skipped (no changes): ${key}`);
                    }
                } catch (err) {
                    outputChannel.appendLine(`  ! failed to write ${key}: ${toErrorMessage(err)}`);
                }
            }
            outputChannel.appendLine('');
        }
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
                ? `This gist is untrusted (${gistId}). Extension install/uninstall is blocked. Set soloboisSettingsSync.gistTrust["${gistId}"] = "trusted" to enable.`
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
            } = await filterExtensionsByMarketplace(ctx, remoteExtensions);

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

                uninstalledCount = await settingsManager.uninstallExtraExtensions(remoteExtensions);

                const extDiffs = generateExtensionsDiff(oldText, filteredJson);
                if (extDiffs.length > 0) {
                    for (const diff of extDiffs) {
                        outputChannel.appendLine(`  ${diff}`);
                    }
                }

                const uniqueUnavailable = uniqueList(unavailableIds);
                // Private extension fallback
                const privateCfg = vscode.workspace.getConfiguration('soloboisSettingsSync');
                const privateExts: PrivateExtensionEntry[] = getSafePrivateExtensions(privateCfg);
                const privateById = new Map(privateExts.map((entry) => [normalizePrivateExtensionId(entry.id), entry]));
                const installedVersionById = new Map<string, string>(
                    vscode.extensions.all.map((ext) => [ext.id.toLowerCase(), ext.packageJSON?.version ?? '0.0.0'])
                );
                const autoDetectOptions = getAutoDetectOptions(privateCfg);
                let privateExtsChanged = false;
                for (const id of uniqueUnavailable) {
                    const label = displayById.get(id) || id;
                    const privateEntry = privateById.get(normalizePrivateExtensionId(id));
                    if (privateEntry?.syncGistKey) {
                        outputChannel.appendLine(`  [private] installing from Gist payload: ${label}`);
                        const gistIdForPrivate = config.get<string>('gistId', '');
                        if (!gistIdForPrivate) {
                            outputChannel.appendLine(`  ! private install failed: ${label} - gistId is not configured.`);
                        } else {
                            const tempVsixPath = path.join(
                                os.tmpdir(),
                                `soloboi-private-${privateEntry.id.replace(/[^a-z0-9.-]/gi, '-')}-${Date.now()}.vsix`
                            );
                            try {
                                const token = await authManager.getToken();
                                if (!token) {
                                    throw new Error('Not logged in to GitHub');
                                }
                                await gistService.getGist(gistIdForPrivate, token);
                                await gistService.downloadPrivateVsix(gistIdForPrivate, privateEntry.syncGistKey, tempVsixPath);
                                await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(tempVsixPath));
                                outputChannel.appendLine(`  + installed from Gist: ${label}`);
                            } catch (err: any) {
                                outputChannel.appendLine(`  ! private install failed: ${label} - ${err?.message ?? err}`);
                            } finally {
                                try {
                                    if (fs.existsSync(tempVsixPath)) {
                                        fs.unlinkSync(tempVsixPath);
                                    }
                                } catch {
                                    // ignore temp cleanup failure
                                }
                            }
                        }
                    } else if (privateEntry?.vsixUrl) {
                        outputChannel.appendLine(`  [private] installing from VSIX URL: ${label}`);
                        try {
                            await installFromVsixUrl(
                                { id: privateEntry.id, currentVersion: '0.0.0', latestVersion: privateEntry.version, marketplaceDomain: '' },
                                outputChannel,
                                privateEntry.vsixUrl
                            );
                        } catch (err: any) {
                            outputChannel.appendLine(`  ! private install failed: ${label} - ${err?.message ?? err}`);
                        }
                    } else if (privateEntry) {
                        const detectedVersion = installedVersionById.get(id.toLowerCase()) || '0.0.0';
                        const merged = mergeDetectedPrivateExtension(privateEntry, { id, version: detectedVersion }, autoDetectOptions);
                        if (merged.changed) {
                            const normalized = normalizePrivateExtensionId(privateEntry.id);
                            privateById.set(normalized, merged.entry);
                            const existingIndex = privateExts.findIndex((entry) =>
                                normalizePrivateExtensionId(entry.id) === normalized
                            );
                            if (existingIndex >= 0) {
                                privateExts[existingIndex] = merged.entry;
                            } else {
                                privateExts.push(merged.entry);
                            }
                            privateExtsChanged = true;
                        }
                        const localPath = getExtensionLocalPath(merged.entry.id, merged.entry.version);
                        outputChannel.appendLine(`  ! ${label} is a private extension - manual install required.`);
                        outputChannel.appendLine(`    Local path hint: ${localPath}`);
                        if (merged.entry.note) {
                            outputChannel.appendLine(`    Note: ${merged.entry.note}`);
                        }
                    } else {
                        outputChannel.appendLine(`  ! skipped (not found in marketplace): ${label}`);
                        const detectedVersion = installedVersionById.get(id.toLowerCase()) || '0.0.0';
                        const merged = mergeDetectedPrivateExtension(undefined, { id, version: detectedVersion }, autoDetectOptions);
                        privateExts.push(merged.entry);
                        privateById.set(normalizePrivateExtensionId(merged.entry.id), merged.entry);
                        privateExtsChanged = true;
                        outputChannel.appendLine(`    Auto-registered as private extension (manual mode).`);
                    }
                }
                if (privateExtsChanged) {
                    const requireConfirm = autoDetectOptions.requireConfirm;
                    let applyAutoDetectChange = true;
                    if (requireConfirm && !silent) {
                        const selection = await vscode.window.showInformationMessage(
                            'Auto-detect found private extension metadata updates. Apply now?',
                            'Apply',
                            'Skip'
                        );
                        applyAutoDetectChange = selection === 'Apply';
                    }

                    if (applyAutoDetectChange) {
                        await privateCfg.update('privateExtensions', privateExts, vscode.ConfigurationTarget.Global);
                        ctx.treeProvider.refresh();
                    } else {
                        outputChannel.appendLine('  ! auto-detect private extension metadata changes were skipped by user.');
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
    ctx.updateStatusBar('idle');

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
        let msg = "Soloboi's Settings Sync complete: settings applied.";
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
