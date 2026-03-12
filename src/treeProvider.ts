import * as vscode from 'vscode';
import { AuthManager } from './auth';
import { GistService } from './gistService';

const GIST_DESCRIPTION_PREFIX = 'Soloboi\'s Settings Sync - ';

export class SoloboiSyncTreeProvider implements vscode.TreeDataProvider<SyncTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<SyncTreeItem | undefined | void> = new vscode.EventEmitter<SyncTreeItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<SyncTreeItem | undefined | void> = this._onDidChangeTreeData.event;

    constructor(
        private authManager?: AuthManager,
        private gistService?: GistService
    ) {
        if (this.authManager) {
            this.authManager.onDidChange(() => this.refresh());
        }
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SyncTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: SyncTreeItem): Promise<SyncTreeItem[]> {
        if (element) {
            return [];
        }

        const items: SyncTreeItem[] = [];

        // Auth Section
        const isLoggedIn = this.authManager?.isLoggedIn() || false;
        const accountLabel = this.authManager?.getAccountLabel();

        if (isLoggedIn) {
            items.push(new SyncTreeItem(
                `GitHub: ${accountLabel}`,
                'Logout from GitHub',
                vscode.TreeItemCollapsibleState.None,
                { command: 'soloboisSettingsSync.logout', title: 'Logout' },
                new vscode.ThemeIcon('log-out')
            ));
        } else {
            items.push(new SyncTreeItem(
                'GitHub Login',
                'Login to GitHub to sync settings',
                vscode.TreeItemCollapsibleState.None,
                { command: 'soloboisSettingsSync.login', title: 'Login' },
                new vscode.ThemeIcon('log-in')
            ));
        }

        items.push(new SyncTreeItem(
            '',
            '',
            vscode.TreeItemCollapsibleState.None,
            undefined,
            undefined,
            'separator'
        ));

        // Existing Actions
        items.push(new SyncTreeItem(
            'Upload Settings to Gist',
            '현재 VS Code 설정을 GitHub Gist에 백업(업로드)합니다.',
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.uploadNow', title: 'Upload Settings to Gist' },
            new vscode.ThemeIcon('cloud-upload')
        ));
        items.push(new SyncTreeItem(
            'Download Settings from Gist',
            'GitHub Gist에서 설정을 가져와 현재 에디터에 적용(다운로드)합니다.',
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.downloadNow', title: 'Download Settings from Gist' },
            new vscode.ThemeIcon('cloud-download')
        ));
        items.push(new SyncTreeItem(
            'Show Gist History',
            '이전 버전의 설정으로 복원합니다.',
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.showHistory', title: 'Show Gist History' },
            new vscode.ThemeIcon('history')
        ));
        items.push(new SyncTreeItem(
            'Set Gist ID',
            'Gist ID를 수동으로 입력합니다.',
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.setGistId', title: 'Set Gist ID' },
            new vscode.ThemeIcon('key')
        ));

        // Existing Gists Section (if logged in)
        if (isLoggedIn && this.gistService && this.authManager) {
            const token = await this.authManager.getToken();
            if (token) {
                try {
                    const gists = await this.gistService.getUserGists(token);
                    const syncGists = gists.filter(g => g.description && g.description.startsWith(GIST_DESCRIPTION_PREFIX));
                    
                    if (syncGists.length > 0) {
                        items.push(new SyncTreeItem(
                            '',
                            '',
                            vscode.TreeItemCollapsibleState.None,
                            undefined,
                            undefined,
                            'separator'
                        ));
                        
                        items.push(new SyncTreeItem(
                            'Existing Gists',
                            '기존에 생성된 동기화 Gist 목록입니다.',
                            vscode.TreeItemCollapsibleState.Expanded,
                            undefined,
                            new vscode.ThemeIcon('repo')
                        ));

                        for (const g of syncGists) {
                            const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
                            const currentGistId = config.get<string>('gistId');
                            const isCurrent = g.id === currentGistId;
                            
                            const label = g.description.replace(GIST_DESCRIPTION_PREFIX, '') || g.id;
                            const item = new SyncTreeItem(
                                (isCurrent ? '✓ ' : '') + label,
                                `Gist ID: ${g.id}\nLast updated: ${new Date(g.updated_at).toLocaleString()}`,
                                vscode.TreeItemCollapsibleState.None,
                                { command: 'soloboisSettingsSync.selectGist', title: 'Select Gist', arguments: [g.id] },
                                new vscode.ThemeIcon(isCurrent ? 'check' : 'gist')
                            );
                            items.push(item);
                        }
                    }
                } catch (err) {
                    console.error('Failed to fetch Gists for tree view', err);
                }
            }
        }

        items.push(new SyncTreeItem(
            '',
            '',
            vscode.TreeItemCollapsibleState.None,
            undefined,
            undefined,
            'separator'
        ));

        items.push(new SyncTreeItem(
            'Manage Ignored Extensions',
            '동기화에서 제외할 익스텐션을 선택합니다.',
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.configureIgnoredExtensions', title: 'Manage Ignored Extensions' },
            new vscode.ThemeIcon('extensions')
        ));

        items.push(new SyncTreeItem(
            'Manage Ignored Settings',
            '동기화에서 제외할 설정 키를 선택합니다.',
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.configureIgnoredSettings', title: 'Manage Ignored Settings' },
            new vscode.ThemeIcon('list-filter')
        ));

        items.push(new SyncTreeItem(
            'Extension Settings',
            'Soloboi\'s Settings Sync 확장 설정을 엽니다.',
            vscode.TreeItemCollapsibleState.None,
            { command: 'workbench.action.openSettings', title: 'Open Settings', arguments: ['@ext:soloboi.solobois-settings-sync'] },
            new vscode.ThemeIcon('settings-gear')
        ));

        return items;
    }
}

export class SyncTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly tooltip: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly command?: vscode.Command,
        public readonly iconPath?: vscode.ThemeIcon,
        public readonly contextValue?: string
    ) {
        super(label, collapsibleState);
        this.tooltip = tooltip;
        this.command = command;
        this.iconPath = iconPath;
        this.contextValue = contextValue;
    }
}
