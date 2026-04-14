import * as crypto from 'crypto';
import type { GistTrustLevel, RemoteExtensionEntry, SyncDiff, SyncManifest } from '../types';

export type GistTrustOptions = {
    accountLabel?: string | null;
    trustMap?: Record<string, string>;
};

function stripJsonc(input: string): string {
    let isInsideString = false;
    let isInsideSingleLineComment = false;
    let isInsideMultiLineComment = false;
    let cleaned = '';

    for (let i = 0; i < input.length; i++) {
        const char = input[i];
        const nextChar = input[i + 1];

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
            if (char === '"' && input[i - 1] !== '\\') {
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
}

export function sha256(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function generateSettingsDiff(oldText: string | null, newText: string): string[] {
    const diffs: string[] = [];
    if (!oldText) {
        return ['+ (local file missing, full write)'];
    }

    try {
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
            if (!(key in newObj)) {
                diffs.push(`- removed: ${key}`);
            }
        }
    } catch {
        if (oldText.trim() !== newText.trim()) {
            diffs.push('~ text changed');
        }
    }

    return diffs;
}

export function generateExtensionsDiff(oldListStr: string | null, newListStr: string): string[] {
    const diffs: string[] = [];

    try {
        const oldList = oldListStr ? JSON.parse(oldListStr) : [];
        const newList = JSON.parse(newListStr);
        const oldIds = new Set(oldList.map((entry: any) => entry.id));
        const newIds = new Set(newList.map((entry: any) => entry.id));

        for (const ext of newList) {
            if (!oldIds.has(ext.id)) {
                diffs.push(`+ install target: ${ext.name || ext.id}`);
            }
        }

        for (const ext of oldList) {
            if (!newIds.has(ext.id)) {
                diffs.push(`- remove target: ${ext.name || ext.id}`);
            }
        }
    } catch {
        // ignore
    }

    return diffs;
}

export function generateSettingsKeyDiff(
    oldText: string | null,
    newText: string
): { added: string[]; changed: string[]; removed: string[] } {
    if (!oldText) {
        return { added: [], changed: ['(local file missing, full write)'], removed: [] };
    }

    try {
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

export function hasContentChanged(oldContent: string | null, newContent: string): boolean {
    const before = (oldContent || '').trim();
    const after = (newContent || '').trim();
    return before !== after;
}

export function uniqueList(values: string[]): string[] {
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

export function parseExtensionList(content: string): RemoteExtensionEntry[] {
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

export function extensionLabel(entry: RemoteExtensionEntry): string {
    const id = entry.id.trim();
    const name = (entry.name || '').trim();

    if (!name || name.toLowerCase() === id.toLowerCase()) {
        return id;
    }

    return `${name} (${id})`;
}

export function getGistTrustLevel(gistData: any, gistId: string, options?: GistTrustOptions): GistTrustLevel {
    const ownerLogin = typeof gistData?.owner?.login === 'string' ? gistData.owner.login.trim() : '';
    const accountLabel = (options?.accountLabel || '').trim();

    if (ownerLogin && accountLabel && ownerLogin.toLowerCase() === accountLabel.toLowerCase()) {
        return 'self';
    }

    const trustMap = options?.trustMap || {};
    const entry = (trustMap[gistId] || '').trim().toLowerCase();
    return entry === 'trusted' ? 'trusted' : 'untrusted';
}

export function readSyncManifest(fileMap: Record<string, { content?: string }>): SyncManifest | null {
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

export function formatSyncPreviewSummary(diff: SyncDiff, gistId: string, trustLevel: GistTrustLevel): string {
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

export function formatRestorePreviewSummary(diff: SyncDiff, sha: string, trustLevel: GistTrustLevel): string {
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

export function isManagedGistFile(filename: string): boolean {
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

export function getManagedGistFilesToDelete(
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

export function computeExtensionActions(
    oldListStr: string | null | undefined,
    newListStr: string | null | undefined
): { toInstall: string[]; toRemove: string[] } {
    const toInstall: string[] = [];
    const toRemove: string[] = [];

    try {
        const oldList = oldListStr ? JSON.parse(oldListStr) : [];
        const newList = newListStr ? JSON.parse(newListStr) : [];
        const oldIds = new Set((Array.isArray(oldList) ? oldList : []).map((entry: any) => String(entry?.id || '').toLowerCase()).filter(Boolean));
        const newIds = new Set((Array.isArray(newList) ? newList : []).map((entry: any) => String(entry?.id || '').toLowerCase()).filter(Boolean));

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
