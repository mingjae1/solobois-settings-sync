import * as vscode from 'vscode';
import { AuthManager } from './auth';
import { GistService } from './gistService';
import { getSafePrivateExtensions } from './privateExtensions/registry';

const GIST_DESCRIPTION_PREFIX = "Soloboi's Settings Sync - ";

type SectionId = 'sync' | 'profile-gist' | 'private' | 'filters' | 'experiments' | 'help';

export class SoloboiSyncTreeProvider implements vscode.TreeDataProvider<SyncTreeItem>, vscode.Disposable {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<SyncTreeItem | undefined | void>();
    private readonly disposables: vscode.Disposable[] = [];
    readonly onDidChangeTreeData: vscode.Event<SyncTreeItem | undefined | void> = this._onDidChangeTreeData.event;

    constructor(
        private authManager?: AuthManager,
        private gistService?: GistService
    ) {
        if (this.authManager) {
            this.disposables.push(this.authManager.onDidChange(() => this.refresh()));
        }

        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (this.affectsTreeConfiguration(event)) {
                    this.refresh();
                }
            })
        );
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables.length = 0;
        this._onDidChangeTreeData.dispose();
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
            case 'sync':
                return this.getSyncChildren();
            case 'profile-gist':
                return await this.getProfileGistChildren();
            case 'private':
                return this.getPrivateChildren();
            case 'filters':
                return this.getFiltersChildren();
            case 'experiments':
                return this.getExperimentsChildren();
            case 'help':
                return this.getHelpChildren();
            default:
                return [];
        }
    }

    private getTopLevel(): SyncTreeItem[] {
        const isLoggedIn = this.authManager?.isLoggedIn() || false;
        const accountLabel = this.authManager?.getAccountLabel() || 'Unknown account';
        const config = vscode.workspace.getConfiguration('soloboisSettingsSync');

        const items: SyncTreeItem[] = [];

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

        items.push(section('Sync', 'sync', 'cloud-upload'));
        items.push(section('Profile & Gist', 'profile-gist', 'account'));

        const privateExts = getSafePrivateExtensions(config);
        items.push(section(
            `Private Extensions${privateExts.length > 0 ? ` (${privateExts.length})` : ''}`,
            'private', 'lock'
        ));

        items.push(section('Filters', 'filters', 'list-filter'));
        items.push(section('Experiments', 'experiments', 'beaker'));
        items.push(section('Help', 'help', 'question'));

        return items;
    }

    private getExperimentsChildren(): SyncTreeItem[] {
        return [
            new SyncTreeItem(
                'Docker Environment Info',
                'Show detected Docker (LinuxServer.io code-server) settings and extensions paths.',
                vscode.TreeItemCollapsibleState.None,
                { command: 'soloboisSettingsSync.showDockerPathInfo', title: 'Docker Environment Info' },
                new vscode.ThemeIcon('server')
            ),
            new SyncTreeItem(
                'Check Marketplace Health',
                'Check marketplace availability/status for extension IDs.',
                vscode.TreeItemCollapsibleState.None,
                { command: 'soloboisSettingsSync.checkExtensionHealth', title: 'Check Marketplace Health' },
                new vscode.ThemeIcon('pulse')
            ),
            new SyncTreeItem(
                'Run Settings E2E Test',
                'Run isolated launch test to validate settings write/apply behavior.',
                vscode.TreeItemCollapsibleState.None,
                { command: 'soloboisSettingsSync.runSettingsE2ETest', title: 'Run Settings E2E Test' },
                new vscode.ThemeIcon('beaker')
            ),
        ];
    }

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
                'Smart two-way sync: downloads remote first to safely merge, then uploads local.\n\nDifferent from "Upload + Download": if download fails, upload is blocked to protect your remote settings.\nTip: status bar icon also triggers this.',
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
            new SyncTreeItem(
                'Share Settings',
                'Create a public snapshot of your settings and copy a shareable link.\nSecrets are automatically masked before sharing.',
                vscode.TreeItemCollapsibleState.None,
                { command: 'soloboisSettingsSync.shareSettings', title: 'Share Settings' },
                new vscode.ThemeIcon('link-external')
            ),
        ];
    }

    private async getProfileGistChildren(): Promise<SyncTreeItem[]> {
        const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
        const isPublic = config.get<boolean>('publicGist', false);
        const isLoggedIn = this.authManager?.isLoggedIn() || false;

        const items: SyncTreeItem[] = [
            new SyncTreeItem(
                `Gist: ${isPublic ? 'Public' : 'Private'}`,
                `New Gists will be created as ${isPublic ? 'public (visible to anyone)' : 'private (secret)'}. Click to toggle.`,
                vscode.TreeItemCollapsibleState.None,
                { command: 'soloboisSettingsSync.togglePublicGist', title: 'Toggle Gist Visibility' },
                new vscode.ThemeIcon(isPublic ? 'globe' : 'lock')
            ),
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
            try {
                const token = await this.authManager.getToken();
                if (token) {
                    const gists = await this.gistService.getUserGists(token);
                    const syncGists = (Array.isArray(gists) ? gists : []).filter((g: any) => (
                        typeof g?.description === 'string' && g.description.startsWith(GIST_DESCRIPTION_PREFIX)
                    ));

                    if (syncGists.length > 0) {
                        items.push(new SyncTreeItem(
                            'Your Gists',
                            'Previously created sync Gists. Click one to set it as active.',
                            vscode.TreeItemCollapsibleState.None,
                            undefined,
                            new vscode.ThemeIcon('repo')
                        ));

                        const currentGistId = config.get<string>('gistId');
                        for (const g of syncGists) {
                            const gistId = typeof g?.id === 'string' ? g.id : '';
                            if (!gistId) {
                                continue;
                            }

                            const description = typeof g.description === 'string' ? g.description : gistId;
                            const label = description.replace(GIST_DESCRIPTION_PREFIX, '') || gistId;
                            const isCurrent = gistId === currentGistId;
                            const isPublicGist = g.public === true;

                            items.push(new SyncTreeItem(
                                `${isCurrent ? '\u2713 ' : '  '}${label}${isPublicGist ? ' [public]' : ' [private]'}`,
                                `Gist ID: ${gistId}\nVisibility: ${isPublicGist ? 'Public' : 'Private'}\nLast updated: ${this.formatTimestamp(g.updated_at)}`,
                                vscode.TreeItemCollapsibleState.None,
                                { command: 'soloboisSettingsSync.setGistId', title: 'Set Gist ID', arguments: [gistId] },
                                new vscode.ThemeIcon(isCurrent ? 'check' : (isPublicGist ? 'globe' : 'lock'))
                            ));
                        }
                    }
                }
            } catch (error) {
                const message = error instanceof Error && error.message ? error.message : 'Unknown error';
                items.push(new SyncTreeItem(
                    'Failed to load sync gists',
                    `An error occurred while loading your Gists: ${message}`,
                    vscode.TreeItemCollapsibleState.None,
                    undefined,
                    new vscode.ThemeIcon('warning')
                ));
            }
        }

        return items;
    }

    private getPrivateChildren(): SyncTreeItem[] {
        const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
        const privateExts = getSafePrivateExtensions(config);
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
                const syncMethod = ext.syncGistKey
                    ? 'gist'
                    : ext.vsixUrl
                        ? 'url'
                        : 'manual';

                const syncBadge = syncMethod === 'gist'
                    ? '[Gist]'
                    : syncMethod === 'url'
                        ? '[URL]'
                        : '[manual]';

                const syncIcon = syncMethod === 'gist'
                    ? 'cloud'
                    : syncMethod === 'url'
                        ? 'link'
                        : 'warning';

                const tooltipLines = [
                    `Sync method: ${syncBadge}`,
                    syncMethod === 'gist'
                        ? `Gist file: ${ext.syncGistKey}`
                        : syncMethod === 'url'
                            ? `VSIX URL: ${ext.vsixUrl}`
                            : 'No VSIX URL - manual install required',
                    ext.note ? `Note: ${ext.note}` : '',
                    '',
                    'Click to remove from registry.'
                ].filter(l => l !== null && l !== undefined && l !== '').join('\n').trim();

                items.push(new SyncTreeItem(
                    `${ext.id} v${ext.version}  ${syncBadge}`,
                    tooltipLines,
                    vscode.TreeItemCollapsibleState.None,
                    { command: 'soloboisSettingsSync.removePrivateExtension', title: 'Remove', arguments: [ext.id] },
                    new vscode.ThemeIcon(syncIcon)
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
        items.push(new SyncTreeItem(
            'Auto-detect Private Extensions',
            'Detect installed extensions that are not available in public marketplaces and register them as private (manual mode).',
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.autoDetectPrivateExtensions', title: 'Auto-detect Private Extensions' },
            new vscode.ThemeIcon('search')
        ));
        items.push(new SyncTreeItem(
            'Upload VSIX to Gist',
            'Upload a local VSIX file to your sync Gist (Tier 1 - no external hosting needed).',
            vscode.TreeItemCollapsibleState.None,
            { command: 'soloboisSettingsSync.uploadPrivateVsixToGist', title: 'Upload VSIX to Gist' },
            new vscode.ThemeIcon('cloud-upload')
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
                'Select User Data Directory',
                'Pick settings/keybindings location using the file manager.',
                vscode.TreeItemCollapsibleState.None,
                { command: 'soloboisSettingsSync.pickUserDataDir', title: 'Select User Data Directory' },
                new vscode.ThemeIcon('folder-opened')
            ),
            new SyncTreeItem(
                'Select Extensions Directory',
                'Pick extensions location using the file manager.',
                vscode.TreeItemCollapsibleState.None,
                { command: 'soloboisSettingsSync.pickExtensionsDir', title: 'Select Extensions Directory' },
                new vscode.ThemeIcon('folder-library')
            ),
            new SyncTreeItem(
                'Select Additional Sync Files',
                'Pick extra files to include in sync using the file manager.',
                vscode.TreeItemCollapsibleState.None,
                { command: 'soloboisSettingsSync.pickAdditionalFiles', title: 'Select Additional Sync Files' },
                new vscode.ThemeIcon('files')
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

    private affectsTreeConfiguration(event: vscode.ConfigurationChangeEvent): boolean {
        return (
            event.affectsConfiguration('soloboisSettingsSync') ||
            event.affectsConfiguration('soloboisSettingsSync.gistId') ||
            event.affectsConfiguration('soloboisSettingsSync.publicGist') ||
            event.affectsConfiguration('soloboisSettingsSync.privateExtensions') ||
            event.affectsConfiguration('soloboisSettingsSync.ignoredExtensions') ||
            event.affectsConfiguration('soloboisSettingsSync.ignoredSettings')
        );
    }

    private formatTimestamp(value: unknown): string {
        if (typeof value !== 'string' || !value) {
            return 'Unknown';
        }

        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) {
            return 'Unknown';
        }

        return parsed.toLocaleString();
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


