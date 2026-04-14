import * as vscode from 'vscode';

export type Platform = 'antigravity' | 'vscode' | 'unknown';

export function detectPlatform(appName: string = vscode.env.appName || ''): Platform {
    const normalized = (typeof appName === 'string' ? appName : '').trim().toLowerCase();

    if (!normalized) {
        return 'unknown';
    }

    if (/anti[\s_-]*gravity/.test(normalized)) {
        return 'antigravity';
    }

    if (
        normalized.includes('visual studio code') ||
        normalized.includes('vscode') ||
        normalized.includes('vscodium') ||
        normalized.includes('code - oss') ||
        normalized.includes('code-oss') ||
        normalized === 'code' ||
        normalized.startsWith('code ')
    ) {
        return 'vscode';
    }

    return 'unknown';
}
