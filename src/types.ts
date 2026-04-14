export type OmissionSummary = {
    skippedSettingKeys: string[];
    skippedAntigravityFiles: string[];
};

export type GistTrustLevel = 'self' | 'trusted' | 'untrusted';

export type SyncDiff = {
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

export type PendingUploadState = {
    timestamp: string;
    reason: string;
};

export type SyncProfile = {
    gistId: string;
    ignoredSettings: string[];
    ignoredExtensions: string[];
};

export type GettingStartedAction =
    | 'login'
    | 'useExistingGist'
    | 'createOrUpload'
    | 'syncNow'
    | 'viewDiff'
    | 'viewLog'
    | 'openSettings'
    | 'openRepo'
    | 'reportIssue';

export type SyncOptions = {
    syncSettings: boolean;
    syncExtensions: boolean;
    syncKeybindings: boolean;
    syncSnippets: boolean;
    syncAntigravityConfig: boolean;
};

export type SyncManifest = {
    version?: number;
    timestamp?: string;
    hashes?: Record<string, string>;
    changedFiles?: string[];
};

export type RemoteExtensionEntry = {
    id: string;
    name?: string;
};

export type SyncIndex = {
    changedPaths: string[];
    extensionActions: {
        toInstall: string[];
        toRemove: string[];
    };
};
