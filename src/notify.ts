import * as vscode from 'vscode';

const PREFIX = "Soloboi's Settings Sync";

function msg(text: string): string {
    return `${PREFIX}: ${text}`;
}

export const notify = {
    info(text: string, ...actions: string[]): Thenable<string | undefined> {
        return vscode.window.showInformationMessage(msg(text), ...actions);
    },
    warn(text: string, ...actions: string[]): Thenable<string | undefined> {
        return vscode.window.showWarningMessage(msg(text), ...actions);
    },
    error(text: string, ...actions: string[]): Thenable<string | undefined> {
        return vscode.window.showErrorMessage(msg(text), ...actions);
    },
    withLog(
        kind: 'info' | 'warn' | 'error',
        text: string,
        outputChannel: vscode.OutputChannel
    ): void {
        const show = kind === 'error' ? notify.error : kind === 'warn' ? notify.warn : notify.info;
        void show(text, 'View Log').then(sel => {
            if (sel === 'View Log') {
                outputChannel.show(true);
            }
        });
    }
};

export async function requireAuth(
    authManager: { getToken(): Promise<string | null> }
): Promise<string | null> {
    const token = await authManager.getToken();
    if (!token) {
        void notify.warn('Please log in to GitHub first.');
        return null;
    }
    return token;
}

export function requireGistId(
    config?: vscode.WorkspaceConfiguration
): string | null {
    const cfg = config ?? vscode.workspace.getConfiguration('soloboisSettingsSync');
    const gistId = (cfg.get<string>('gistId') ?? '').trim();
    if (!gistId) {
        void notify.warn('Gist ID is not set.');
        return null;
    }
    return gistId;
}
