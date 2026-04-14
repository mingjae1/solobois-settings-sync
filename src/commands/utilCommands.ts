import * as vscode from 'vscode';
import type { AppContext } from '../context';
import { runGettingStartedWizard } from '../ui/gettingStarted';

export function registerUtilCommands(context: vscode.ExtensionContext, ctx: AppContext): void {
    const {
        outputChannel,
        logChannel,
        authManager
    } = ctx;

    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.openSettings', async () => {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'soloboisSettingsSync');
        }),
        vscode.commands.registerCommand('soloboisSettingsSync.openRepository', async () => {
            const repoUrl = (context.extension.packageJSON?.repository?.url as string | undefined) || '';
            if (!repoUrl) {
                vscode.window.showWarningMessage("Soloboi's Settings Sync: Repository URL is not set.");
                return;
            }
            await vscode.env.openExternal(vscode.Uri.parse(repoUrl));
        }),
        vscode.commands.registerCommand('soloboisSettingsSync.reportIssue', async () => {
            const issuesUrl = (context.extension.packageJSON?.bugs?.url as string | undefined) || '';
            if (!issuesUrl) {
                vscode.window.showWarningMessage("Soloboi's Settings Sync: Issues URL is not set.");
                return;
            }
            await vscode.env.openExternal(vscode.Uri.parse(issuesUrl));
        }),
        vscode.commands.registerCommand('soloboisSettingsSync.showLog', async () => {
            logChannel.show(true);
            outputChannel.show(false);
        }),
        vscode.commands.registerCommand('soloboisSettingsSync.getStarted', async () => {
            await runGettingStartedWizard(context, authManager?.isLoggedIn() ?? false);
        })
    );
}
