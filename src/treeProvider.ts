import * as vscode from 'vscode';
import { AuthManager } from './auth';
import { GistService } from './gistService';
import { marketplaceManager } from './marketplaceManager';

const GIST_DESCRIPTION_PREFIX = "Soloboi's Settings Sync - ";

type SectionId = 'sync' | 'gist' | 'settings' | 'marketplace' | 'private' | 'filters' | 'help';

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
        if (!element) {
            return this.getTopLevel();
        }

        const sectionId = element.sectionId;
        switch (sectionId) {
            case 'sync':        return this.getSyncChildren();
            case 'gist':        return await this.getGistChildren();
            case 'settings':    return this.getSettingsChildren();
            case 'marketplace': return this.getMarketplaceChildren();
            case 'private':     return this.getPrivateChildren();
            case 'filters':     return this.getFiltersChildren();
            case 'help':        return this.getHelpChildren();
            default:            return [];
        }
    }

    // ── Top-level items ───────────────────────────────────────────────────────

    private getTopLevel(): SyncTreeItem[] {
        const isLoggedIn = this.authManager?.isLoggedIn() || false;
        const accountLabel = this.authManager?.getAccountLabel();
        const config = vscode.workspace.getConfiguration('soloboisSettingsSync');

        const items: SyncTreeItem[] = [];

        // Auth row — stays flat (single action, no children)
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

        // Collapsible section headers
        items.push(section('Sync', 'sync', 'cloud-upload'));
        items.push(section('Gist', 'gist', 'repo'));
        items.push(section('Settings', 'settings', 'settings-gear'));

        const marketplaces = marketplaceManager.getOrderedMarketplaces();
        const marketplaceCount = marketplaces.length;
        items.push(section(
            `Custom Marketplace${marketplaceCount > 0 ? ` (${marketplaceCount})` : ''}`,
            'marketplace', 'extensions'
        ));

        const privateExts = config.get<any[]>('privateExtensions', []);
        items.push(section(
            `Private Extensions${privateExts.length > 0 ? ` (${privateExts.length})` : ''}`,
            'private', 'lock'
        ));

        items.push(section('Filters', 'filters', 'list-filter'));
        items.push(section('Help', 'help', 'question'));

        return items;
    }

    // ── Section children ──────────────────────────────────────────────────────

    private getSyncChildren(): SyncTreeItem[] {
        return [
            new SyncTreeItem(
                'Upload Settings',
                'Back up your VS Code settings to GitHub Gist.',
                vscode.TreeItemCollapsibleState.None,
                { command: 'soloboisSettingsSync.uploadNow', title: 'Upload' },
                new vscode.ThemeIcon('cloud-upload')
            ),
            new SyncTreeItem(
                'Download Settings',
                'Download settings from GitHub Gist and apply them.',
                vscode.TreeItemCollapsibleState.None,
                { command: 'soloboisSettingsSync.downloadNow', title: 'Download' },
                new vscode.ThemeIcon('cloud-download')
            ),
            new SyncTreeItem(
                'Sync Now',
                'Smart two-way sync: downloads remote first to safely merge, then uploads local.\n\n⚠️ Different from "Upload → Download" — if download fails, upload is blocked to protect your remote settings.\nTip: status bar icon also triggers this.',
                vscode.TreeItemCollapsibleState.None,
                { command: 'soloboisSettingsSync.syncNow', title: 'Sync Now' },
                new vscode.ThemeIcon('sync')
            ),
            new SyncTreeItem(
                'View Local vs Remote Diff',
                'Compare your local settings with the current Gist without applying changes.',
                vscode.TreeItemCollapsibleState.None,
                { command: 'soloboisSettingsSync.showLocalVsRemoteDiff', title: 'View Diff' },
                new vscode.ThemeIcon('diff')
            ),
        ];
    }

    private async getGistChildren(): Promise<SyncTreeItem[]> {
        const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
        const isLoggedIn = this.authManager?.isLoggedIn() || false;

        const items: SyncTreeItem[] = [
            new SyncTreeItem(
                'Set Gist ID',
                'Manually enter a Gist ID to use for sync.',
                vscode.TreeItemCollapsibleState.None,
                { command: 'soloboisSettingsSync.setGistId', title: 'Set Gist ID' },
                new vscode.ThemeIcon('key')
            ),
            new SyncTreeItem(
                'Switch Profile',
                'Switch between saved sync profiles.',
                vscode.TreeItemCollapsibleState.None,
                { command: 'soloboisSettingsSync.switchProfile', title: 'Switch Profile' },
                new vscode.ThemeIcon('account')
            ),
            new SyncTreeItem(
                'Show History',
                'Browse and restore a previous version of your settings.',
                vscode.TreeItemCollapsibleState.None,
                { command: 'soloboisSettingsSync.showHistory', title: 'Show History' },
                new vscode.ThemeIcon('history')
            ),
        ];

        if (isLoggedIn && this.gistService && this.authManager) {
            const token = await this.authManager.getToken();
            if (token) {
                try {
                    const gists = await this.gistService.getUserGists(token);
                    const syncGists = gists.filter((g: any) => g.description?.startsWith(GIST_DESCRIPTION_PREFIX));
                    if (syncGists.length > 0) {
                        items.push(new SyncTreeItem(
                            '── Your Gists ──',
                            'Previously created sync Gists. Click one to set it as active.',
                            vscode.TreeItemCollapsibleState.None,
                            undefined,
                            new vscode.ThemeIcon('gist')
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

        return items;
    }

    private getSettingsChildren(): SyncTreeItem[] {
        const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
        const isPublic = config.get<boolean>('publicGist', false);

        return [
            new SyncTreeItem(
                `Public Gist: ${isPublic ? 'ON' : 'OFF'}`,
                `New Gists will be created as ${isPublic ? 'public (visible to anyone)' : 'private'}. Click to toggle.`,
                vscode.TreeItemCollapsibleState.None,
                { command: 'soloboisSettingsSync.togglePublicGist', title: 'Toggle Public Gist' },
                new vscode.ThemeIcon(isPublic ? 'globe' : 'lock')
            ),
            new SyncTreeItem(
                'Share Your Settings',
                'Create a public snapshot of your settings and copy a shareable link.\nSecrets are automatically masked before sharing.',
                vscode.TreeItemCollapsibleState.None,
                { command: 'soloboisSettingsSync.shareSettings', title: 'Share Your Settings' },
                new vscode.ThemeIcon('link-external')
            ),
        ];
    }

    private getMarketplaceChildren(): SyncTreeItem[] {
        const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
        const items: SyncTreeItem[] = [];

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
                    `URL: ${entry.url}\n\n🗑 Click to remove this marketplace.`,
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
            'Health Check',
            'Check which installed extensions are available in the marketplace.',
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.checkExtensionHealth', title: 'Health Check' },
            new vscode.ThemeIcon('pulse')
        ));

        return items;
    }

    private getPrivateChildren(): SyncTreeItem[] {
        const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
        const privateExts = config.get<any[]>('privateExtensions', []);
        const items: SyncTreeItem[] = [];

        if (privateExts.length === 0) {
            items.push(new SyncTreeItem(
                'No private extensions registered',
                'Click Register to add a private extension for sync guidance.',
                vscode.TreeItemCollapsibleState.None,
                undefined,
                new vscode.ThemeIcon('info')
            ));
        } else {
            for (const ext of privateExts) {
                items.push(new SyncTreeItem(
                    `${ext.id} v${ext.version}`,
                    [
                        ext.vsixUrl ? `VSIX URL: ${ext.vsixUrl}` : '⚠️ No VSIX URL — manual install required',
                        ext.note ? `Note: ${ext.note}` : '',
                        '\n🗑 Click to remove from registry.'
                    ].filter(Boolean).join('\n'),
                    vscode.TreeItemCollapsibleState.None,
                    { command: 'soloboisSettingsSync.removePrivateExtension', title: 'Remove Private Extension', arguments: [ext.id] },
                    new vscode.ThemeIcon(ext.vsixUrl ? 'package' : 'warning')
                ));
            }
        }

        items.push(new SyncTreeItem(
            'Register Private Extension',
            'Add a private/unlisted extension for sync guidance or auto-install.',
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.registerPrivateExtension', title: 'Register Private Extension' },
            new vscode.ThemeIcon('add')
        ));

        return items;
    }

    private getFiltersChildren(): SyncTreeItem[] {
        return [
            new SyncTreeItem(
                'Ignored Extensions',
                'Choose extensions to exclude from sync.',
                vscode.TreeItemCollapsibleState.None,
                { command: 'soloboisSettingsSync.configureIgnoredExtensions', title: 'Manage Ignored Extensions' },
                new vscode.ThemeIcon('extensions')
            ),
            new SyncTreeItem(
                'Ignored Settings',
                'Choose setting keys to exclude from sync.',
                vscode.TreeItemCollapsibleState.None,
                { command: 'soloboisSettingsSync.configureIgnoredSettings', title: 'Manage Ignored Settings' },
                new vscode.ThemeIcon('list-filter')
            ),
        ];
    }

    private getHelpChildren(): SyncTreeItem[] {
        return [
            new SyncTreeItem(
                'Getting Started',
                'Open the Getting Started wizard.',
                vscode.TreeItemCollapsibleState.None,
                { command: 'soloboisSettingsSync.getStarted', title: 'Getting Started' },
                new vscode.ThemeIcon('rocket')
            ),
            new SyncTreeItem(
                'Open Settings',
                "Open Soloboi's Settings Sync settings.",
                vscode.TreeItemCollapsibleState.None,
                { command: 'soloboisSettingsSync.openSettings', title: 'Open Settings' },
                new vscode.ThemeIcon('gear')
            ),
            new SyncTreeItem(
                'Open GitHub Repository',
                'Open the project repository in your browser.',
                vscode.TreeItemCollapsibleState.None,
                { command: 'soloboisSettingsSync.openRepository', title: 'Open Repository' },
                new vscode.ThemeIcon('mark-github')
            ),
            new SyncTreeItem(
                'Report an Issue',
                'Open GitHub issues to report a bug or request a feature.',
                vscode.TreeItemCollapsibleState.None,
                { command: 'soloboisSettingsSync.reportIssue', title: 'Report Issue' },
                new vscode.ThemeIcon('bug')
            ),
            new SyncTreeItem(
                'View Log',
                "Open Soloboi's Settings Sync log channel.",
                vscode.TreeItemCollapsibleState.None,
                { command: 'soloboisSettingsSync.showLog', title: 'View Log' },
                new vscode.ThemeIcon('output')
            ),
        ];
    }
}

function section(label: string, id: SectionId, icon: string): SyncTreeItem {
    return new SyncTreeItem(
        label,
        '',
        vscode.TreeItemCollapsibleState.Collapsed,
        undefined,
        new vscode.ThemeIcon(icon),
        `section:${id}`,
        id
    );
}

export class SyncTreeItem extends vscode.TreeItem {
    sectionId?: SectionId;

    constructor(
        label: string,
        tooltip: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        command?: vscode.Command,
        iconPath?: vscode.ThemeIcon,
        contextValue?: string,
        sectionId?: SectionId
    ) {
        super(label, collapsibleState);
        this.tooltip = tooltip;
        this.command = command;
        this.iconPath = iconPath;
        this.contextValue = contextValue;
        this.sectionId = sectionId;
    }
}
