/**
 * Shared sync helper functions — all take AppContext directly (no module state).
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import { checkMarketplaceForPlatform, ExtensionAvailability } from '../marketplaceChecker';
import { parseJsonc, normalizeIgnoredSettings, normalizeExtensionIds } from '../utils';
import { generateSettingsKeyDiff, getGistTrustLevel, hasContentChanged, parseExtensionList, readSyncManifest, sha256 } from './syncEngine';
import { getInstalledUserExtensionIds } from './profileManager';
import type { SyncDiff, SyncOptions, GistTrustLevel } from '../types';
import type { Platform } from '../platformDetector';
import type { AppContext } from '../context';
import { INTENTIONALLY_REMOVED_KEY } from '../constants';

export function isAntigravityPlatform(platform: Platform): boolean {
    return platform === 'antigravity';
}

export function getSyncOptions(ctx: AppContext, config?: vscode.WorkspaceConfiguration): SyncOptions {
    const cfg = config || vscode.workspace.getConfiguration('soloboisSettingsSync');
    const inferredDefault = isAntigravityPlatform(ctx.platform);
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

export function filterSettingsByPlatform(
    settingsText: string,
    platform: Platform
): { content: string; skippedKeys: string[] } {
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

export async function filterExtensionsByMarketplace(
    ctx: AppContext,
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
    const availability = await checkMarketplaceForPlatform(ids, ctx.platform);

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

export async function promptUnknownExtensionsAction(
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

export function getLocalComparableContent(ctx: AppContext, filename: string): string | null {
    const { settingsManager } = ctx;
    const normalized = filename.toLowerCase();
    if (normalized === 'settings.json') { return settingsManager.readLocalSettings(); }
    if (normalized === 'keybindings.json') { return settingsManager.readLocalKeybindings(); }
    if (normalized === 'extensions.json') { return settingsManager.readInstalledExtensions(); }
    if (normalized === 'snippets.json') { return settingsManager.readSnippets(); }
    if (normalized === 'antigravity.json') { return settingsManager.readAntigravityConfig(); }
    if (normalized === 'browserallowlist.txt') { return settingsManager.readBrowserAllowlist(); }
    return null;
}

export function computeHashSkipSet(
    ctx: AppContext,
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

        if (normalized === 'settings.json' && !syncOptions.syncSettings) {
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

        const localContent = getLocalComparableContent(ctx, normalized);
        if (localContent === null) {
            continue;
        }

        if (sha256(localContent) === expectedHash) {
            skip.add(normalized);
        }
    }

    return skip;
}

export async function computeSyncDiff(
    ctx: AppContext,
    gistData: any,
    context: vscode.ExtensionContext,
    gistId: string,
    trustLevel: GistTrustLevel
): Promise<SyncDiff> {
    const { settingsManager } = ctx;
    const fileMap = (gistData?.files || {}) as Record<string, { content?: string }>;
    const syncOptions = getSyncOptions(ctx);
    const antigravityMode = isAntigravityPlatform(ctx.platform);
    const skipByHash = computeHashSkipSet(ctx, fileMap, syncOptions, antigravityMode);

    const diff: SyncDiff = {
        settings: { added: [], changed: [], removed: [] },
        extensions: { toInstall: [], toRemove: [] },
        snippets: { changed: false }
    };

    if (syncOptions.syncSettings && fileMap['settings.json'] && !skipByHash.has('settings.json')) {
        const remoteSettings = fileMap['settings.json'].content || '{}';
        const filtered = filterSettingsByPlatform(remoteSettings, ctx.platform);
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
            const { filteredJson } = await filterExtensionsByMarketplace(ctx, remoteExtensions);
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
                const remoteIds = new Set(
                    parseExtensionList(remoteExtensions).map(entry => entry.id.toLowerCase())
                );
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

export function getExtensionContributedSettingKeys(ext: vscode.Extension<any> | undefined): string[] {
    if (!ext) {
        return [];
    }

    const contributes = ext.packageJSON?.contributes?.configuration;
    if (!contributes) {
        return [];
    }

    const configs = Array.isArray(contributes) ? contributes : [contributes];
    const keys = configs.flatMap((c: any) => Object.keys(c?.properties ?? {}));
    return normalizeIgnoredSettings(keys);
}

export function buildExtensionContributionMap(): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const ext of vscode.extensions.all) {
        map.set(ext.id.toLowerCase(), getExtensionContributedSettingKeys(ext));
    }
    return map;
}

export async function installExtensionViaCLI(id: string): Promise<void> {
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
