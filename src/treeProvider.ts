import * as vscode from 'vscode';
import { AuthManager } from './auth';
import { GistService } from './gistService';
import { marketplaceManager } from './marketplaceManager';

const GIST_DESCRIPTION_PREFIX = "Soloboi's Settings Sync - ";

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
        const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
        const isLoggedIn = this.authManager?.isLoggedIn() || false;
        const accountLabel = this.authManager?.getAccountLabel();

        // ── AUTH ──────────────────────────────────────────────────────────────
        if (isLoggedIn) {
            items.push(new SyncTreeItem(
                `GitHub: ${accountLabel}`,
                'Click to logout from GitHub.',
                vscode.TreeItemCollapsibleState.None,
                { command: 'soloboisSettingsSync.logout', title: 'Logout' },
                new vscode.ThemeIcon('log-out')
            ));
        } else {
            items.push(new SyncTreeItem(
                'GitHub Login',
                'Login to GitHub to enable sync.',
                vscode.TreeItemCollapsibleState.None,
                { command: 'soloboisSettingsSync.login', title: 'Login' },
                new vscode.ThemeIcon('log-in')
            ));
        }

        items.push(separator());

        // ── SYNC ACTIONS ──────────────────────────────────────────────────────
        items.push(new SyncTreeItem(
            'Upload Settings',
            'Back up your VS Code settings to GitHub Gist.',
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.uploadNow', title: 'Upload' },
            new vscode.ThemeIcon('cloud-upload')
        ));
        items.push(new SyncTreeItem(
            'Download Settings',
            'Download settings from GitHub Gist and apply them.',
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.downloadNow', title: 'Download' },
            new vscode.ThemeIcon('cloud-download')
        ));
        items.push(new SyncTreeItem(
            'Sync Now',
            'Upload then download — full two-way sync.',
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.syncNow', title: 'Sync Now' },
            new vscode.ThemeIcon('sync')
        ));
        items.push(new SyncTreeItem(
            'Show History',
            'Browse and restore a previous version of your settings.',
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.showHistory', title: 'Show History' },
            new vscode.ThemeIcon('history')
        ));
        items.push(new SyncTreeItem(
            'View Local vs Remote Diff',
            'Compare your local settings with the current Gist without applying changes.',
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.showLocalVsRemoteDiff', title: 'View Diff' },
            new vscode.ThemeIcon('diff')
        ));

        items.push(separator());

        // ── GIST CONFIGURATION ────────────────────────────────────────────────
        items.push(new SyncTreeItem(
            'Set Gist ID',
            'Manually enter a Gist ID to use for sync.',
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.setGistId', title: 'Set Gist ID' },
            new vscode.ThemeIcon('key')
        ));
        items.push(new SyncTreeItem(
            'Switch Profile',
            'Switch between saved sync profiles.',
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.switchProfile', title: 'Switch Profile' },
            new vscode.ThemeIcon('account')
        ));

        if (isLoggedIn && this.gistService && this.authManager) {
            const token = await this.authManager.getToken();
            if (token) {
                try {
                    const gists = await this.gistService.getUserGists(token);
                    const syncGists = gists.filter((g: any) => g.description?.startsWith(GIST_DESCRIPTION_PREFIX));
                    if (syncGists.length > 0) {
                        items.push(new SyncTreeItem(
                            'Existing Gists',
                            'Previously created sync Gists. Click one to set it as active.',
                            vscode.TreeItemCollapsibleState.None,
                            undefined,
                            new vscode.ThemeIcon('repo')
                        ));
                        const currentGistId = config.get<string>('gistId');
                        for (const g of syncGists) {
                            const isCurrent = g.id === currentGistId;
                            const label = g.description.replace(GIST_DESCRIPTION_PREFIX, '') || g.id;
                            items.push(new SyncTreeItem(
                                (isCurrent ? '\u2713 ' : '  ') + label,
                                `Gist ID: ${g.id}\nLast updated: ${new Date(g.updated_at).toLocaleString()}`,
                                vscode.TreeItemCollapsibleState.None,
                                { command: 'soloboisSettingsSync.selectGist', title: 'Select Gist', arguments: [g.id] },
                                new vscode.ThemeIcon(isCurrent ? 'check' : 'gist')
                            ));
                        }
                    }
                } catch {
                    // silent — network errors should not crash the tree
                }
            }
        }

        items.push(separator());

        // ── QUICK SETTINGS ────────────────────────────────────────────────────
        const isPublic = config.get<boolean>('publicGist', false);
        items.push(new SyncTreeItem(
            `Public Gist: ${isPublic ? 'ON' : 'OFF'}`,
            `New Gists will be created as ${isPublic ? 'public (visible to anyone)' : 'private'}. Click to toggle.`,
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.togglePublicGist', title: 'Toggle Public Gist' },
            new vscode.ThemeIcon(isPublic ? 'globe' : 'lock')
        ));

        items.push(separator());

        // ── CUSTOM MARKETPLACE ────────────────────────────────────────────────
        items.push(new SyncTreeItem(
            'CUSTOM MARKETPLACE',
            'Manage custom OpenVSX-compatible marketplaces.',
            vscode.TreeItemCollapsibleState.None,
            undefined,
            new vscode.ThemeIcon('extensions'),
            'section-header'
        ));

        const marketplaces = marketplaceManager.getOrderedMarketplaces();
        if (marketplaces.length === 0) {
            items.push(new SyncTreeItem(
                'No marketplaces registered',
                'Click Add Marketplace to register an OpenVSX-compatible URL.',
                vscode.TreeItemCollapsibleState.None,
                undefined,
                new vscode.ThemeIcon('info')
            ));
        } else {
            for (const entry of marketplaces) {
                items.push(new SyncTreeItem(
                    entry.domain,
                    `URL: ${entry.url}\nClick to remove.`,
                    vscode.TreeItemCollapsibleState.None,
                    { command: 'soloboisSettingsSync.removeMarketplace', title: 'Remove Marketplace', arguments: [entry.domain] },
                    new vscode.ThemeIcon('link')
                ));
            }
        }

        items.push(new SyncTreeItem(
            'Add Marketplace',
            'Register a new OpenVSX-compatible marketplace URL.',
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.addMarketplace', title: 'Add Marketplace' },
            new vscode.ThemeIcon('add')
        ));
        items.push(new SyncTreeItem(
            'Scan Order',
            'Change the order in which marketplaces are checked as fallback.',
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.reorderMarketplace', title: 'Scan Order' },
            new vscode.ThemeIcon('list-ordered')
        ));

        const autoUpdate = config.get<boolean>('customMarketplaceAutoUpdate', false);
        items.push(new SyncTreeItem(
            `Auto-Update: ${autoUpdate ? 'ON' : 'OFF'}`,
            `Automatically install updates from custom marketplaces. Click to toggle.`,
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.toggleCustomMarketplaceAutoUpdate', title: 'Toggle Auto-Update' },
            new vscode.ThemeIcon(autoUpdate ? 'sync' : 'sync-ignored')
        ));
        items.push(new SyncTreeItem(
            'Check for Updates',
            'Check custom marketplaces for extension updates now.',
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.checkCustomMarketplaceUpdates', title: 'Check Updates' },
            new vscode.ThemeIcon('arrow-up')
        ));
        items.push(new SyncTreeItem(
            'Marketplace Health Check',
            'Check which installed extensions are available in the marketplace.',
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.checkExtensionHealth', title: 'Health Check' },
            new vscode.ThemeIcon('pulse')
        ));

        // ── PRIVATE EXTENSIONS ────────────────────────────────────────────────
        const privateExts = config.get<any[]>('privateExtensions', []);
        items.push(new SyncTreeItem(
            `Private Extensions (${privateExts.length})`,
            privateExts.length > 0
                ? `${privateExts.length} private extension(s) registered. Click to register a new one.`
                : 'No private extensions registered. Click to add one for sync guidance.',
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.registerPrivateExtension', title: 'Register Private Extension' },
            new vscode.ThemeIcon('lock')
        ));

        items.push(separator());

        // ── FILTERS ───────────────────────────────────────────────────────────
        items.push(new SyncTreeItem(
            'Manage Ignored Extensions',
            'Choose extensions to exclude from sync.',
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.configureIgnoredExtensions', title: 'Manage Ignored Extensions' },
            new vscode.ThemeIcon('extensions')
        ));
        items.push(new SyncTreeItem(
            'Manage Ignored Settings',
            'Choose setting keys to exclude from sync.',
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.configureIgnoredSettings', title: 'Manage Ignored Settings' },
            new vscode.ThemeIcon('list-filter')
        ));

        items.push(separator());

        // ── HELP ──────────────────────────────────────────────────────────────
        items.push(new SyncTreeItem(
            'HELP',
            'Open settings and support links.',
            vscode.TreeItemCollapsibleState.None,
            undefined,
            new vscode.ThemeIcon('question'),
            'section-header'
        ));
        items.push(new SyncTreeItem(
            'Getting Started',
            'Open the Getting Started wizard.',
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.getStarted', title: 'Getting Started' },
            new vscode.ThemeIcon('rocket')
        ));
        items.push(new SyncTreeItem(
            'Open Settings',
            'Open Soloboi\'s Settings Sync settings.',
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.openSettings', title: 'Open Settings' },
            new vscode.ThemeIcon('gear')
        ));
        items.push(new SyncTreeItem(
            'Open GitHub Repository',
            'Open the project repository in your browser.',
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.openRepository', title: 'Open Repository' },
            new vscode.ThemeIcon('mark-github')
        ));
        items.push(new SyncTreeItem(
            'Report an Issue',
            'Open GitHub issues to report a bug or request a feature.',
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.reportIssue', title: 'Report Issue' },
            new vscode.ThemeIcon('bug')
        ));
        items.push(new SyncTreeItem(
            'View Log',
            "Open Soloboi's Settings Sync log channel.",
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.showLog', title: 'View Log' },
            new vscode.ThemeIcon('output')
        ));

        return items;
    }
}

function separator(): SyncTreeItem {
    return new SyncTreeItem('', '', vscode.TreeItemCollapsibleState.None, undefined, undefined, 'separator');
}

export class SyncTreeItem extends vscode.TreeItem {
    constructor(
        label: string,
        tooltip: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        command?: vscode.Command,
        iconPath?: vscode.ThemeIcon,
        contextValue?: string
    ) {
        super(label, collapsibleState);
        this.tooltip = tooltip;
        this.command = command;
        this.iconPath = iconPath;
        this.contextValue = contextValue;
        if (contextValue === 'separator') {
            // TreeItemKind.Separator = 1 (VS Code 1.67+, not yet in @types/vscode 1.109)
            (this as any)['kind'] = 1;
        }
    }
}
