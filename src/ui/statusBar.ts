import * as vscode from 'vscode';

export type StatusBarState = 'idle' | 'uploading' | 'downloading' | 'syncing' | 'error' | 'logged-out' | string;

export class StatusBarController {
    private readonly item: vscode.StatusBarItem;

    constructor() {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.item.command = 'soloboisSettingsSync.syncNow';
    }

    update(state: StatusBarState, detail?: string): void {
        switch (state) {
            case 'uploading':
                this.item.text = '$(sync~spin) Uploading...';
                this.item.tooltip = 'Uploading settings...';
                break;
            case 'downloading':
                this.item.text = '$(sync~spin) Downloading...';
                this.item.tooltip = 'Downloading settings...';
                break;
            case 'syncing':
                this.item.text = '$(sync~spin) Syncing...';
                this.item.tooltip = detail || 'Syncing settings...';
                break;
            case 'error':
                this.item.text = '$(error) Sync Error';
                this.item.tooltip = 'A sync error occurred.';
                setTimeout(() => this.update('idle', detail), 5000);
                break;
            case 'logged-out':
                this.item.text = '$(sign-in) Soloboi\'s Settings Sync';
                this.item.tooltip = 'Click to sign in and sync settings.';
                break;
            default:
                this.item.text = '$(sync) Soloboi\'s Settings Sync';
                if (detail) {
                    this.item.tooltip = `Last sync: ${new Date(detail).toLocaleString()}\nClick to sync now.`;
                } else {
                    this.item.tooltip = 'Click to sync now.';
                }
                break;
        }
    }

    show(): void { this.item.show(); }
    hide(): void { this.item.hide(); }
    dispose(): void { this.item.dispose(); }
}
