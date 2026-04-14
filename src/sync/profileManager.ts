import * as os from 'os';
import * as vscode from 'vscode';
import type { PendingUploadState, SyncProfile } from '../types';
import {
    DEFAULT_PROFILE_NAME,
    GIST_DESCRIPTION_PREFIX,
    INTENTIONALLY_REMOVED_KEY,
    LAST_SYNC_KEY,
    LOCAL_STATE_TIMESTAMP_KEY,
    PENDING_UPLOAD_KEY
} from '../constants';
import { normalizeExtensionIds, normalizeIgnoredSettings, parseTimestamp } from '../utils';
import { parseExtensionList } from './syncEngine';

type StatusBarState = 'idle' | 'uploading' | 'downloading' | 'error' | 'logged-out';

type GistServiceLike = {
    getUserGists(token: string): Promise<any[]>;
    createGist(
        description: string,
        files: Record<string, { content: string }>,
        token: string,
        isPublic: boolean
    ): Promise<{ id: string }>;
};

type ProfileManagerRuntime = {
    gistService?: GistServiceLike;
    settingsManager?: {
        readInstalledExtensions(): string;
    };
    updateStatusBar?: (state: StatusBarState, detail?: string) => void;
    setLastSyncTime?: (timestamp: string) => void;
    buildGistFiles?: () => Record<string, { content: string }> | null;
    withSyncMetadataFiles?: (
        files: Record<string, { content: string }>,
        existingFiles?: Record<string, any>
    ) => Record<string, { content: string }>;
};

let runtime: ProfileManagerRuntime = {};

export function configureProfileManager(deps: ProfileManagerRuntime): void {
    runtime = { ...runtime, ...deps };
}

export function getCurrentProfileName(config: vscode.WorkspaceConfiguration): string {
    const raw = (config.get<string>('currentProfile', DEFAULT_PROFILE_NAME) || '').trim();
    return raw || DEFAULT_PROFILE_NAME;
}

export function getCurrentGlobalSyncState(config: vscode.WorkspaceConfiguration): SyncProfile {
    return {
        gistId: (config.get<string>('gistId', '') || '').trim(),
        ignoredSettings: normalizeIgnoredSettings(config.get<string[]>('ignoredSettings', [])),
        ignoredExtensions: normalizeExtensionIds(config.get<string[]>('ignoredExtensions', []))
    };
}

export function normalizeProfiles(raw: unknown): Record<string, SyncProfile> {
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

export async function saveCurrentProfileFromGlobal(config?: vscode.WorkspaceConfiguration): Promise<void> {
    const cfg = config || vscode.workspace.getConfiguration('soloboisSettingsSync');
    const profileName = getCurrentProfileName(cfg);
    const profiles = normalizeProfiles(cfg.get<Record<string, unknown>>('profiles', {}));
    profiles[profileName] = getCurrentGlobalSyncState(cfg);
    await cfg.update('profiles', profiles, vscode.ConfigurationTarget.Global);
}

export async function applyProfileToGlobalSettings(profileName: string, config?: vscode.WorkspaceConfiguration): Promise<void> {
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

export async function initializeProfiles(): Promise<void> {
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

export function getManagedExtensionsSnapshot(): string {
    if (!runtime.settingsManager) {
        throw new Error('profileManager is not configured: settingsManager is missing.');
    }
    return runtime.settingsManager.readInstalledExtensions();
}

export function parseExtensionIds(content: string | null | undefined): Set<string> {
    return new Set(
        normalizeExtensionIds(
            parseExtensionList(content || '')
                .map(entry => entry.id)
        )
    );
}

export function getInstalledUserExtensionIds(): Set<string> {
    return new Set(
        vscode.extensions.all
            .filter(ext => !ext.packageJSON?.isBuiltin)
            .map(ext => ext.id.toLowerCase())
    );
}

export async function cleanupIgnoredExtensions(): Promise<void> {
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

export async function pruneIntentionallyRemovedExtensions(
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

export async function markLocalStateChanged(
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

export async function markStateSynchronized(
    context: vscode.ExtensionContext,
    timestamp: string
): Promise<void> {
    await context.globalState.update(LAST_SYNC_KEY, timestamp);
    await context.globalState.update(LOCAL_STATE_TIMESTAMP_KEY, timestamp);
    await context.globalState.update(PENDING_UPLOAD_KEY, undefined);
    runtime.setLastSyncTime?.(timestamp);
}

export function getPendingUploadState(context: vscode.ExtensionContext): PendingUploadState | null {
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

export async function selectOrCreateGist(
    context: vscode.ExtensionContext,
    token: string,
    files: any,
    silent: boolean
): Promise<string | null> {
    void context;

    if (silent) {
        return null;
    }

    if (!runtime.gistService) {
        throw new Error('profileManager is not configured: gistService is missing.');
    }

    runtime.updateStatusBar?.('downloading');

    let gists: any[] = [];
    try {
        gists = await runtime.gistService.getUserGists(token);
    } catch {
        vscode.window.showErrorMessage("Soloboi's Settings Sync: Failed to fetch Gist list.");
        runtime.updateStatusBar?.('idle');
        return null;
    }

    const platformGists = gists.filter(g =>
        g.description && g.description.startsWith(GIST_DESCRIPTION_PREFIX)
    );

    runtime.updateStatusBar?.('idle');

    if (platformGists.length === 0) {
        return createNewGist(token, files, silent);
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

    if (!selected) {
        return null;
    }

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

export async function createNewGist(token: string, files: any, silent: boolean): Promise<string | null> {
    if (!runtime.gistService) {
        throw new Error('profileManager is not configured: gistService is missing.');
    }
    if (!runtime.buildGistFiles) {
        throw new Error('profileManager is not configured: buildGistFiles is missing.');
    }
    if (!runtime.withSyncMetadataFiles) {
        throw new Error('profileManager is not configured: withSyncMetadataFiles is missing.');
    }

    const dateStr = new Date().toLocaleString();
    const hostname = os.hostname();
    const description = `${GIST_DESCRIPTION_PREFIX}${hostname} (${dateStr})`;

    const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
    const isPublic = config.get<boolean>('publicGist', false);

    try {
        runtime.updateStatusBar?.('uploading');
        const baseFiles = (files || runtime.buildGistFiles()) as Record<string, { content: string }> | null;
        if (!baseFiles) {
            throw new Error('No sync files were generated.');
        }
        const result = await runtime.gistService.createGist(
            description,
            runtime.withSyncMetadataFiles(baseFiles),
            token,
            isPublic
        );
        runtime.updateStatusBar?.('idle');

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
        runtime.updateStatusBar?.('error');
        return null;
    }
}
