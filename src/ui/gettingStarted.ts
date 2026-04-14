import * as vscode from 'vscode';
import type { GettingStartedAction } from '../types';

export async function runGettingStartedWizard(
    context: vscode.ExtensionContext,
    isLoggedIn: boolean
): Promise<void> {
    const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
    const gistId = config.get<string>('gistId');
    const hasGistId = !!gistId;

    type Item = vscode.QuickPickItem & { action?: GettingStartedAction };
    const items: Item[] = [];

    // ── Step 1: Login (if not logged in) ─────────────────────────────
    if (!isLoggedIn) {
        items.push({
            label: '$(account) Login to GitHub',
            description: 'Required first step — authorize via GitHub',
            action: 'login'
        });
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    }

    // ── Step 2: First-time setup ──────────────────────────────────────
    items.push({
        label: '$(bookmark) First time? Start here',
        kind: vscode.QuickPickItemKind.Separator
    });

    items.push({
        label: '$(key) I already have a sync Gist',
        description: hasGistId
            ? `Current Gist: ${gistId!.substring(0, 8)}... — enter a different ID or download`
            : 'Paste your Gist ID or URL, then download your settings',
        action: 'useExistingGist'
    });

    items.push({
        label: '$(cloud-upload) I want to create a new Gist',
        description: 'Uploads your local settings and creates a new private Gist',
        action: 'createOrUpload'
    });

    // ── Step 3: Day-to-day actions ────────────────────────────────────
    items.push({
        label: '$(sync) Already set up? Actions',
        kind: vscode.QuickPickItemKind.Separator
    });

    items.push({
        label: '$(sync) Sync Now',
        description: 'Two-way sync: download remote changes, then upload local',
        action: 'syncNow'
    });

    items.push({
        label: '$(diff) View Local vs Remote Diff',
        description: 'Preview what would change — no files modified',
        action: 'viewDiff'
    });

    // ── Utilities ─────────────────────────────────────────────────────
    items.push({
        label: '$(tools) Utilities',
        kind: vscode.QuickPickItemKind.Separator
    });

    items.push({
        label: '$(output) View Log',
        description: 'Troubleshooting details and sync history',
        action: 'viewLog'
    });

    items.push({
        label: '$(gear) Open Settings',
        description: 'Configure ignored files, auto-upload, pathStrategy, and more',
        action: 'openSettings'
    });

    items.push({
        label: '$(mark-github) Open GitHub Repository',
        description: 'README, changelog, source code',
        action: 'openRepo'
    });

    items.push({
        label: '$(bug) Report an Issue',
        description: 'Bug report or feature request',
        action: 'reportIssue'
    });

    const picked = await vscode.window.showQuickPick(items, {
        title: "Soloboi's Settings Sync — Getting Started",
        placeHolder: isLoggedIn
            ? hasGistId
                ? 'Logged in and Gist set. What would you like to do?'
                : 'Logged in — set a Gist ID or create a new one to start syncing'
            : 'Start by logging in to GitHub, then set up your Gist'
    });

    if (!picked || !picked.action) {
        return;
    }

    await context.globalState.update('setupPrompted', true);

    switch (picked.action) {
        case 'login':
            await vscode.commands.executeCommand('soloboisSettingsSync.login');
            break;
        case 'useExistingGist':
            await vscode.commands.executeCommand('soloboisSettingsSync.setGistId');
            await vscode.commands.executeCommand('soloboisSettingsSync.downloadNow');
            break;
        case 'createOrUpload':
            await vscode.commands.executeCommand('soloboisSettingsSync.uploadNow');
            break;
        case 'syncNow':
            await vscode.commands.executeCommand('soloboisSettingsSync.syncNow');
            break;
        case 'viewDiff':
            await vscode.commands.executeCommand('soloboisSettingsSync.showLocalVsRemoteDiff');
            break;
        case 'viewLog':
            await vscode.commands.executeCommand('soloboisSettingsSync.showLog');
            break;
        case 'openSettings':
            await vscode.commands.executeCommand('soloboisSettingsSync.openSettings');
            break;
        case 'openRepo':
            await vscode.commands.executeCommand('soloboisSettingsSync.openRepository');
            break;
        case 'reportIssue':
            await vscode.commands.executeCommand('soloboisSettingsSync.reportIssue');
            break;
    }
}
