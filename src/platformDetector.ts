import * as vscode from 'vscode';

export type Platform = 'antigravity' | 'vscode' | 'unknown';

export function detectPlatform(appName: string = vscode.env.appName || ''): Platform {
    const normalized = appName.toLowerCase();

    if (normalized.includes('antigravity')) {
        return 'antigravity';
    }

    if (
        normalized.includes('visual studio code') ||
        normalized.includes('vscode') ||
        normalized === 'code' ||
        normalized.includes(' code')
    ) {
        return 'vscode';
    }

    return 'unknown';
}
