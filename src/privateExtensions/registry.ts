import * as vscode from 'vscode';

export type PrivateExtensionEntry = {
    id: string;
    version: string;
    vsixUrl?: string;
    syncGistKey?: string;
    note?: string;
};

export type AutoDetectVersionPolicy = 'preserve' | 'replace-if-unknown' | 'always-replace';

export const DEFAULT_AUTO_DETECT_NOTE =
    'Auto-detected as private (not found in public marketplaces). Add VSIX URL or upload to Gist for auto-install.';
export const AUTO_DETECT_NOTE_PREFIX = 'Auto-detected as private';

export function normalizePrivateExtensionId(value: string): string {
    return value.trim().toLowerCase();
}

export function isUnknownPrivateExtensionVersion(value: string | undefined): boolean {
    const v = (value || '').trim().toLowerCase();
    return !v || v === '0.0.0' || v === 'unknown';
}

export function getSafePrivateExtensions(config: vscode.WorkspaceConfiguration): PrivateExtensionEntry[] {
    const raw = config.get<unknown>('privateExtensions', []);
    if (!Array.isArray(raw)) {
        return [];
    }

    const entries: PrivateExtensionEntry[] = [];
    for (const value of raw) {
        if (!value || typeof value !== 'object') {
            continue;
        }

        const candidate = value as Record<string, unknown>;
        const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
        if (!id) {
            continue;
        }

        const version = typeof candidate.version === 'string' && candidate.version.trim()
            ? candidate.version.trim()
            : '0.0.0';
        const vsixUrl = typeof candidate.vsixUrl === 'string' && candidate.vsixUrl.trim()
            ? candidate.vsixUrl.trim()
            : undefined;
        const syncGistKey = typeof candidate.syncGistKey === 'string' && candidate.syncGistKey.trim()
            ? candidate.syncGistKey.trim()
            : undefined;
        const note = typeof candidate.note === 'string' && candidate.note.trim()
            ? candidate.note.trim()
            : undefined;

        entries.push({ id, version, vsixUrl, syncGistKey, note });
    }

    return entries;
}

export function getAutoDetectOptions(config: vscode.WorkspaceConfiguration): {
    requireConfirm: boolean;
    noteTemplate: string;
    versionPolicy: AutoDetectVersionPolicy;
} {
    const requireConfirm = config.get<boolean>('privateExtensionsAutoDetectRequireConfirm', true);
    const noteTemplateRaw = (config.get<string>('privateExtensionsAutoDetectNoteTemplate', DEFAULT_AUTO_DETECT_NOTE) || '').trim();
    const noteTemplate = noteTemplateRaw || DEFAULT_AUTO_DETECT_NOTE;

    const versionPolicyRaw = (config.get<string>('privateExtensionsAutoDetectVersionPolicy', 'replace-if-unknown') || '').trim();
    const versionPolicy: AutoDetectVersionPolicy =
        versionPolicyRaw === 'preserve' || versionPolicyRaw === 'always-replace'
            ? versionPolicyRaw
            : 'replace-if-unknown';

    return { requireConfirm, noteTemplate, versionPolicy };
}

export function mergeDetectedPrivateExtension(
    existing: PrivateExtensionEntry | undefined,
    detected: { id: string; version: string },
    options: { noteTemplate: string; versionPolicy: AutoDetectVersionPolicy }
): { entry: PrivateExtensionEntry; changed: boolean; action: 'add' | 'update' | 'skip' } {
    if (!existing) {
        return {
            entry: {
                id: detected.id,
                version: detected.version,
                note: options.noteTemplate
            },
            changed: true,
            action: 'add'
        };
    }

    const merged: PrivateExtensionEntry = { ...existing };
    let changed = false;

    if (options.versionPolicy === 'always-replace' && merged.version !== detected.version) {
        merged.version = detected.version;
        changed = true;
    }

    if (options.versionPolicy === 'replace-if-unknown' &&
        isUnknownPrivateExtensionVersion(merged.version) &&
        merged.version !== detected.version) {
        merged.version = detected.version;
        changed = true;
    }

    const currentNote = (merged.note || '').trim();
    if (!currentNote) {
        merged.note = options.noteTemplate;
        changed = true;
    } else {
        const lines = currentNote.split('\n').map((line) => line.trim()).filter((line) => !!line);
        const autoNoteIndex = lines.findIndex((line) => line.startsWith(AUTO_DETECT_NOTE_PREFIX));
        if (autoNoteIndex >= 0) {
            if (lines[autoNoteIndex] !== options.noteTemplate) {
                lines[autoNoteIndex] = options.noteTemplate;
                merged.note = lines.join('\n');
                changed = true;
            }
        } else if (!currentNote.includes(options.noteTemplate)) {
            merged.note = `${currentNote}\n${options.noteTemplate}`;
            changed = true;
        }
    }

    return {
        entry: merged,
        changed,
        action: changed ? 'update' : 'skip'
    };
}
