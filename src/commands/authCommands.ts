import * as vscode from 'vscode';
import type { AppContext } from '../context';

export function registerAuthCommands(context: vscode.ExtensionContext, ctx: AppContext): void {
    const {
        authManager,
        updateStatusBar
    } = ctx;

    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.login', async () => {
            await authManager.login();
        }),
        vscode.commands.registerCommand('soloboisSettingsSync.logout', async () => {
            await authManager.logout();
            updateStatusBar('logged-out');
        })
    );
}
