import * as vscode from 'vscode';
import type { GistService } from './gistService';
import type { AuthManager } from './auth';
import type { SettingsManager } from './settingsManager';
import type { SoloboiSyncTreeProvider } from './treeProvider';
import type { AutoUploadController } from './sync/autoUpload';
import type { StatusBarController } from './ui/statusBar';
import type { Platform } from './platformDetector';

export interface AppContext {
    extensionContext: vscode.ExtensionContext;
    outputChannel: vscode.OutputChannel;
    logChannel: vscode.OutputChannel;
    gistService: GistService;
    authManager: AuthManager;
    platform: Platform;
    settingsManager: SettingsManager;
    treeProvider: SoloboiSyncTreeProvider;
    autoUploadController: AutoUploadController;
    statusBarController: StatusBarController;
    updateStatusBar: (state: 'idle' | 'uploading' | 'downloading' | 'error' | 'logged-out', detail?: string) => void;
    diffDocumentStore: Map<string, string>;
}
