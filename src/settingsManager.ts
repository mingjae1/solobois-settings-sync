import * as vscode from 'vscode';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as path from 'path';
import * as crypto from 'crypto';
import { isDeepStrictEqual } from 'util';
import { sensitiveDataGuard } from './sensitiveDataGuard';
import { SettingsPathResolver } from './settings/pathResolver';
import { parseJsonc } from './utils';

/**
 * Manages reading/writing local VS Code settings files, keybindings, and extensions.
 */
export class SettingsManager {

    private readonly _paths = new SettingsPathResolver();

    private isPlainObject(value: unknown): value is Record<string, unknown> {
        return !!value && typeof value === 'object' && !Array.isArray(value);
    }

    private getStringArrayConfig(config: vscode.WorkspaceConfiguration, key: string): string[] {
        const value = config.get<unknown>(key);
        if (!Array.isArray(value)) {
            return [];
        }

        return value.filter((item): item is string => typeof item === 'string');
    }

    private getConfigurationValue(key: string): unknown {
        try {
            return vscode.workspace.getConfiguration().get(key);
        } catch (err) {
            console.warn(`Soloboi's Settings Sync: Failed to read configuration key "${key}"`, err);
            return undefined;
        }
    }

    private stripDefaultSettingEntries(
        settings: Record<string, unknown>
    ): { sanitized: Record<string, unknown>; removedKeys: string[] } {
        const sanitized: Record<string, unknown> = { ...settings };
        const removedKeys: string[] = [];

        for (const key of Object.keys(sanitized)) {
            try {
                const inspected = vscode.workspace.getConfiguration().inspect<unknown>(key);
                if (inspected?.defaultValue === undefined) {
                    continue;
                }
                if (isDeepStrictEqual(sanitized[key], inspected.defaultValue)) {
                    delete sanitized[key];
                    removedKeys.push(key);
                }
            } catch {
                // If inspection fails for a key, keep the value as-is.
            }
        }

        return { sanitized, removedKeys };
    }

    /**
     * Read extension directory names marked for uninstall in `.obsolete`.
     * VS Code/Antigravity writes this file before reload completes uninstall.
     */
    private getPendingUninstallExtensionDirs(): Set<string> {
        const extensionsDir = this.getExtensionsDir();
        if (!extensionsDir) {
            return new Set();
        }

        const obsoletePath = path.join(extensionsDir, '.obsolete');
        if (!fs.existsSync(obsoletePath)) {
            return new Set();
        }

        try {
            const raw = fs.readFileSync(obsoletePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') {
                return new Set();
            }
            return new Set(Object.keys(parsed).map(key => key.toLowerCase()));
        } catch {
            console.warn('Soloboi\'s Settings Sync: Failed to parse .obsolete');
            return new Set();
        }
    }

    /**
     * Get ignored extension IDs from configuration (normalized lowercase).
     */
    private getIgnoredExtensionIds(): Set<string> {
        const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
        const ignored = this.getStringArrayConfig(config, 'ignoredExtensions');
        return new Set(
            ignored
                .map(id => (id || '').trim().toLowerCase())
                .filter(id => !!id)
        );
    }

    private log(msg: string): void {
        console.log(msg);
    }

    private async installExtensionViaCLI(id: string): Promise<void> {
        const appRoot = vscode.env.appRoot;

        const candidates: string[] = [];
        if (process.platform === 'win32') {
            candidates.push(
                path.join(appRoot, '..', 'bin', 'code-server.cmd'),
                path.join(appRoot, '..', 'bin', 'code.cmd'),
                'code-server',
                'code'
            );
        } else if (process.platform === 'darwin') {
            const macBin = path.join(appRoot, '..', '..', '..', 'Contents', 'Resources', 'app', 'bin');
            candidates.push(
                path.join(macBin, 'code-server'),
                path.join(macBin, 'code'),
                'code-server',
                'code'
            );
        } else {
            candidates.push(
                path.join(appRoot, '..', 'bin', 'code-server'),
                path.join(appRoot, '..', 'bin', 'code'),
                'code-server',
                'code'
            );
        }

        let lastError: unknown;
        for (const cliPath of candidates) {
            if (!cliPath.includes(path.sep) || fs.existsSync(cliPath)) {
                try {
                    await new Promise<void>((resolve, reject) => {
                        cp.execFile(cliPath, ['--install-extension', id], err => {
                            if (err) { reject(err); return; }
                            resolve();
                        });
                    });
                    this.log(`[SettingsManager] Installed "${id}" via "${cliPath}"`);
                    return;
                } catch (err) {
                    lastError = err;
                    this.log(`[SettingsManager] CLI failed: "${cliPath}" — ${String(err)}`);
                }
            }
        }
        throw new Error(`Failed to install extension "${id}" via CLI. Last error: ${String(lastError)}`);
    }

    getUserSettingsDir(): string | null { return this._paths.getUserSettingsDir(); }
    getSettingsPath(): string | null { return this._paths.getSettingsPath(); }
    getKeybindingsPath(): string | null { return this._paths.getKeybindingsPath(); }


    /**
     * Read local settings.json content as a string.
     * Uses only the settings explicitly present in settings.json,
     * excluding values equal to current defaults.
     */
    readLocalSettings(): string | null {
        const filePath = this.getSettingsPath();
        if (!filePath || !fs.existsSync(filePath)) {
            return null;
        }
        const content = fs.readFileSync(filePath, 'utf8');
        const fileObj = parseJsonc(content);
        if (!fileObj) {
            // JSONC parse failed ??apply value-based redaction on raw content as fallback
            return sensitiveDataGuard.redactJsonString(content, 'private').result;
        }

        const { sanitized } = this.stripDefaultSettingEntries(fileObj as Record<string, unknown>);
        const merged = { ...sanitized };

        // Filter out ignored keys
        const ignored = this.getIgnoredPatterns();
        if (ignored.length > 0) {
            for (const key of Object.keys(merged)) {
                if (this.shouldIgnore(key, ignored)) {
                    delete merged[key];
                }
            }
        }

        // Convert absolute paths to portable variables for cross-machine sync
        return this.portablizePaths(JSON.stringify(sensitiveDataGuard.redactObject(merged, 'private').result, null, 4));
    }

    /**
     * Read local keybindings.json content as a string.
     * Returns empty array JSON if the file doesn't exist yet.
     */
    readLocalKeybindings(): string {
        const filePath = this.getKeybindingsPath();
        if (!filePath || !fs.existsSync(filePath)) {
            return '[]';
        }
        // keybindings.json is an array, so key-based redaction is skipped here.
        // Command args may still embed secrets and should be reviewed manually before sync.
        return fs.readFileSync(filePath, 'utf8');
    }

    /**
     * Read local settings.json content without any processing.
     */
    readLocalSettingsRaw(): string | null {
        const filePath = this.getSettingsPath();
        if (!filePath || !fs.existsSync(filePath)) {
            return null;
        }
        return fs.readFileSync(filePath, 'utf8');
    }

    /**
     * Parse and return the local settings as an object.
     */
    getLocalSettingsObject(): any {
        const content = this.readLocalSettingsRaw();
        if (!content) return {};
        return parseJsonc(content) || {};
    }

    getExtensionsDir(): string | null { return this._paths.getExtensionsDir(); }

    getAdditionalFilePaths(): string[] { return this._paths.getAdditionalFilePaths(); }

    getConfiguredAdditionalFilePaths(): string[] {
        const homeDir = process.env.HOME || process.env.USERPROFILE || '';
        const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
        const entries = config.get<string[]>('additionalFiles') || [];
        return Array.from(new Set(entries
            .map(p => (p.startsWith('~/') && homeDir) ? path.join(homeDir, p.slice(2)) : p)
            .filter(p => typeof p === 'string' && p.trim().length > 0)));
    }

    private buildAdditionalFileKey(filePath: string, basenameCounts: Map<string, number>): string {
        const basename = path.basename(filePath);
        const count = basenameCounts.get(basename) || 0;
        if (count <= 1) {
            // Keep legacy key format when basename is unique.
            return `additional__${basename}`;
        }

        // Add a stable suffix when there are basename collisions.
        const digest = crypto
            .createHash('sha1')
            .update(path.resolve(filePath))
            .digest('hex')
            .slice(0, 8);
        return `additional__${basename}__${digest}`;
    }

    private buildAdditionalFileKeyMap(includeMissingFiles: boolean): Map<string, string> {
        const sourcePaths = includeMissingFiles
            ? this.getConfiguredAdditionalFilePaths()
            : this.getAdditionalFilePaths();
        const basenameCounts = new Map<string, number>();
        for (const filePath of sourcePaths) {
            const basename = path.basename(filePath);
            basenameCounts.set(basename, (basenameCounts.get(basename) || 0) + 1);
        }

        const keyMap = new Map<string, string>();
        for (const filePath of sourcePaths) {
            const key = this.buildAdditionalFileKey(filePath, basenameCounts);
            keyMap.set(key, filePath);
        }
        return keyMap;
    }

    /**
     * Read all additional files configured by the user.
     * Returns a map of Gist file keys to file contents.
     * Key format: "additional__<basename>" to avoid conflicts with standard Gist files.
     */
    readAdditionalFiles(): Record<string, string> {
        const result: Record<string, string> = {};
        for (const [key, filePath] of this.buildAdditionalFileKeyMap(false)) {
            try {
                result[key] = fs.readFileSync(filePath, 'utf8');
            } catch (err) {
                console.warn(`[SettingsSync] Failed to read additional file ${filePath}:`, err);
            }
        }
        return result;
    }

    /**
     * Write an additional file back to disk during download.
     * Matches the Gist key (e.g. "additional__eclipse-formatter.xml") against
     * the configured additionalFiles paths by basename. Silently skips if no match.
     */
    writeAdditionalFile(filename: string, content: string): boolean {
        const keyMap = this.buildAdditionalFileKeyMap(true);
        let resolved = keyMap.get(filename);
        if (!resolved) {
            // Backward compatibility for legacy key format: additional__<basename>.
            const raw = filename.replace(/^additional__/, '');
            const basename = raw.replace(/__[a-f0-9]{8}$/i, '');
            resolved = this.getConfiguredAdditionalFilePaths()
                .find(p => path.basename(p) === basename);
        }
        if (!resolved) { return false; }

        if (fs.existsSync(resolved)) {
            const current = fs.readFileSync(resolved, 'utf8');
            if (current === content) {
                return false;
            }
        }
        this.ensureDir(path.dirname(resolved));
        fs.writeFileSync(resolved, content, 'utf8');
        return true;
    }

    /**
     * Read all extension configuration values (including defaults).
     * Uses a dual approach:
     *   1) VS Code API (vscode.extensions.all)
     *   2) Disk scan of the extensions directory (fallback for Antigravity fork)
     * This ensures ALL extension settings are captured.
     */
    readAllExtensionSettings(): Record<string, any> {
        const allSettings: Record<string, any> = {};
        const processedKeys = new Set<string>();

        let apiExtCount = 0;
        for (const ext of vscode.extensions.all) {
            const publisher = (ext.packageJSON?.publisher || '').toLowerCase();
            if (publisher === 'vscode') continue;

            const config = ext.packageJSON?.contributes?.configuration;
            if (!config) continue;

            apiExtCount++;
            const configs = Array.isArray(config) ? config : [config];

            for (const cfg of configs) {
                const properties = this.isPlainObject(cfg)
                    ? (cfg.properties as Record<string, unknown> | undefined)
                    : undefined;
                if (!this.isPlainObject(properties)) continue;

                for (const key of Object.keys(properties)) {
                    if (processedKeys.has(key)) continue;
                    processedKeys.add(key);
                    const value = this.getConfigurationValue(key);
                    if (value !== undefined) {
                        allSettings[key] = value;
                    }
                }
            }
        }

        let diskExtCount = 0;
        const extensionsDir = this.getExtensionsDir();
        if (extensionsDir) {
            try {
                const entries = fs.readdirSync(extensionsDir);
                for (const entry of entries) {
                    if (entry === 'extensions.json' || entry === '.obsolete') continue;

                    const pkgPath = path.join(extensionsDir, entry, 'package.json');
                    if (!fs.existsSync(pkgPath)) continue;

                    try {
                        const pkgContent = fs.readFileSync(pkgPath, 'utf8');
                        const pkg = JSON.parse(pkgContent);

                        const publisher = (pkg.publisher || '').toLowerCase();
                        if (publisher === 'vscode') continue;

                        const config = pkg.contributes?.configuration;
                        if (!config) continue;

                        diskExtCount++;
                        const configs = Array.isArray(config) ? config : [config];

                        for (const cfg of configs) {
                            const properties = this.isPlainObject(cfg)
                                ? (cfg.properties as Record<string, unknown> | undefined)
                                : undefined;
                            if (!this.isPlainObject(properties)) continue;

                            for (const [key, propertySchema] of Object.entries(properties)) {
                                if (processedKeys.has(key)) continue;
                                processedKeys.add(key);

                                // Try VS Code API first, fall back to default from package.json
                                const apiValue = this.getConfigurationValue(key);
                                if (apiValue !== undefined) {
                                    allSettings[key] = apiValue;
                                } else if (this.isPlainObject(propertySchema) && 'default' in propertySchema) {
                                    allSettings[key] = (propertySchema as { default?: unknown }).default;
                                }
                            }
                        }
                    } catch {
                        // Skip extensions with invalid package.json
                    }
                }
            } catch (err) {
                console.warn('Soloboi\'s Settings Sync: Failed to scan extensions directory', err);
            }
        }

        console.log(`Soloboi\'s Settings Sync: Collected ${Object.keys(allSettings).length} settings (API: ${apiExtCount} exts, Disk: ${diskExtCount} exts)`);
        return allSettings;
    }

    /**
     * Build a JSON string listing all currently installed extensions.
     * Format: [{ "id": "publisher.name", "name": "...", "version": "...", "publisher": "...", "description": "..." }, ...]
     */
    readInstalledExtensions(): string {
        const pendingUninstallDirs = this.getPendingUninstallExtensionDirs();
        const ignoredIds = this.getIgnoredExtensionIds();
        const extensions = vscode.extensions.all
            .filter(ext => !ext.packageJSON?.isBuiltin) // skip built-in extensions
            .filter(ext => !ignoredIds.has(ext.id.toLowerCase()))
            .filter(ext => {
                const dirName = path.basename(ext.extensionPath || '').toLowerCase();
                return !dirName || !pendingUninstallDirs.has(dirName);
            })
            .map(ext => ({
                id: ext.id,
                name: ext.packageJSON?.displayName || ext.packageJSON?.name || '',
                version: ext.packageJSON?.version || '',
                publisher: ext.packageJSON?.publisher || '',
                description: ext.packageJSON?.description || ''
            }));

        return JSON.stringify(extensions, null, 2);
    }

    getAntigravityDataDir(): string | null { return this._paths.getAntigravityDataDir(); }
    getAntigravityConfigPath(): string | null { return this._paths.getAntigravityConfigPath(); }
    getBrowserAllowlistPath(): string | null { return this._paths.getBrowserAllowlistPath(); }
    getSnippetsDir(): string | null { return this._paths.getSnippetsDir(); }
    getBackupDir(): string | null { return this._paths.getBackupDir(); }

    /**
     * Read local Antigravity config (mcp_config.json).
     */
    readAntigravityConfig(): string | null {
        const filePath = this.getAntigravityConfigPath();
        return this.readRedactedJsonFile(filePath);
    }

    /**
     * Read browserAllowlist.txt content.
     */
    readBrowserAllowlist(): string | null {
        const filePath = this.getBrowserAllowlistPath();
        if (!filePath || !fs.existsSync(filePath)) {
            return null;
        }
        return fs.readFileSync(filePath, 'utf8');
    }

    /**
     * Read all snippet files from the snippets directory.
     * Returns a JSON string: { "filename": "content", ... }
     */
    readSnippets(): string | null {
        const snippetsDir = this.getSnippetsDir();
        if (!snippetsDir || !fs.existsSync(snippetsDir)) {
            return null;
        }

        const snippetFiles: Record<string, string> = {};
        const entries = fs.readdirSync(snippetsDir);

        for (const entry of entries) {
            const ext = path.extname(entry).toLowerCase();
            if (ext === '.json' || ext === '.code-snippets') {
                const filePath = path.join(snippetsDir, entry);
                try {
                    if (fs.statSync(filePath).isFile()) {
                        snippetFiles[entry] = fs.readFileSync(filePath, 'utf8');
                    }
                } catch (err) {
                    console.warn(`Soloboi's Settings Sync: Failed to read snippet file ${entry}`, err);
                }
            }
        }

        if (Object.keys(snippetFiles).length === 0) {
            return null;
        }
        return JSON.stringify(snippetFiles, null, 2);
    }


    /**
     * Backup current settings before download.
     */
    backupCurrentSettings(): void {
        const backupDir = this.getBackupDir();
        if (!backupDir) return;

        const date = new Date();
        const folderName = date.toISOString().replace(/[:.]/g, '-');
        const currentBackupDir = path.join(backupDir, folderName);

        this.ensureDir(currentBackupDir);

        // Copy settings.json
        const settingsPath = this.getSettingsPath();
        if (settingsPath && fs.existsSync(settingsPath)) {
            fs.copyFileSync(settingsPath, path.join(currentBackupDir, 'settings.json'));
        }

        // Copy keybindings.json
        const keybindingsPath = this.getKeybindingsPath();
        if (keybindingsPath && fs.existsSync(keybindingsPath)) {
            fs.copyFileSync(keybindingsPath, path.join(currentBackupDir, 'keybindings.json'));
        }

        // Copy mcp_config.json
        const mcpPath = this.getAntigravityConfigPath();
        if (mcpPath && fs.existsSync(mcpPath)) {
            fs.copyFileSync(mcpPath, path.join(currentBackupDir, 'mcp_config.json'));
        }

        // Copy browserAllowlist.txt
        const allowlistPath = this.getBrowserAllowlistPath();
        if (allowlistPath && fs.existsSync(allowlistPath)) {
            fs.copyFileSync(allowlistPath, path.join(currentBackupDir, 'browserAllowlist.txt'));
        }

        // Copy snippets
        const snippetsDir = this.getSnippetsDir();
        if (snippetsDir && fs.existsSync(snippetsDir)) {
            const backupSnippetsDir = path.join(currentBackupDir, 'snippets');
            this.ensureDir(backupSnippetsDir);
            const entries = fs.readdirSync(snippetsDir);
            for (const entry of entries) {
                const ext = path.extname(entry).toLowerCase();
                if (ext === '.json' || ext === '.code-snippets') {
                    const sourcePath = path.join(snippetsDir, entry);
                    try {
                        if (fs.statSync(sourcePath).isFile()) {
                            fs.copyFileSync(sourcePath, path.join(backupSnippetsDir, entry));
                        }
                    } catch (err) {
                        console.warn(`Soloboi's Settings Sync: Failed to backup snippet file ${entry}`, err);
                    }
                }
            }
        }

        this.cleanOldBackups(backupDir);
    }

    /**
     * Keep only the 5 most recent backups.
     */
    private cleanOldBackups(backupDir: string): void {
        const MAX_BACKUPS = 5;
        if (!fs.existsSync(backupDir)) return;

        const entries = fs.readdirSync(backupDir)
            .map(name => ({ name, time: fs.statSync(path.join(backupDir, name)).mtimeMs }))
            .sort((a, b) => b.time - a.time);

        if (entries.length > MAX_BACKUPS) {
            for (let i = MAX_BACKUPS; i < entries.length; i++) {
                const dirToRemove = path.join(backupDir, entries[i].name);
                fs.rmSync(dirToRemove, { recursive: true, force: true });
            }
        }
    }

    /**
     * Write content to settings.json (deep-merge with existing settings).
     */
    writeLocalSettings(remoteContent: string): void {
        const filePath = this.getSettingsPath();
        if (!filePath) {
            throw new Error('Cannot determine settings.json path');
        }

        // Resolve portable path variables to local machine paths
        const resolvedContent = this.resolvePortablePaths(remoteContent);

        const remoteObj = parseJsonc(resolvedContent);
        if (!remoteObj) {
            throw new Error('Cannot parse remote settings.json');
        }
        if (Array.isArray(remoteObj) || typeof remoteObj !== 'object') {
            throw new Error('Remote settings.json is not a JSON object');
        }

        const ignored = this.getIgnoredPatterns();
        if (ignored.length > 0) {
            for (const key of Object.keys(remoteObj)) {
                if (this.shouldIgnore(key, ignored)) {
                    delete remoteObj[key];
                }
            }
        }

        let localObj: any = {};
        if (fs.existsSync(filePath)) {
            const localContent = fs.readFileSync(filePath, 'utf8');
            localObj = parseJsonc(localContent) ?? {};
        }

        const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
        const authoritativeDownload = config.get<boolean>('authoritativeDownload', false);
        const nextSettings = authoritativeDownload
            ? this.preserveIgnoredLocalSettings(localObj, remoteObj, ignored)
            : this.deepMerge(localObj, remoteObj);

        const { sanitized, removedKeys } = this.stripDefaultSettingEntries(
            nextSettings as Record<string, unknown>
        );
        if (removedKeys.length > 0) {
            console.log(
                `Soloboi's Settings Sync: Removed ${removedKeys.length} default-valued setting(s) during apply.`
            );
        }
        this.writeFileIfChanged(filePath, JSON.stringify(sanitized, null, 4));
    }

    /**
     * Write content to keybindings.json (full overwrite).
     */
    writeLocalKeybindings(content: string): void {
        const filePath = this.getKeybindingsPath();
        if (!filePath) {
            throw new Error('Cannot determine keybindings.json path');
        }
        this.writeFileIfChanged(filePath, content);
    }

    /**
     * Write content to Antigravity config (mcp_config.json).
     * Overwrites the whole file right now.
     */
    writeAntigravityConfig(content: string): void {
        const filePath = this.getAntigravityConfigPath();
        if (!filePath) {
            console.warn('Soloboi\'s Settings Sync: Cannot determine mcp_config.json path');
            return;
        }
        this.writeFileIfChanged(filePath, content);
    }

    /**
     * Write browserAllowlist.txt content.
     */
    writeBrowserAllowlist(content: string): void {
        const filePath = this.getBrowserAllowlistPath();
        if (!filePath) {
            console.warn('Soloboi\'s Settings Sync: Cannot determine browserAllowlist.txt path');
            return;
        }
        this.writeFileIfChanged(filePath, content);
    }

    /**
     * Write snippet files from remote data.
     * Expects a JSON string: { "filename": "content", ... }
     */
    writeSnippets(remoteSnippetsJson: string): void {
        const snippetsDir = this.getSnippetsDir();
        if (!snippetsDir) {
            console.warn('Soloboi\'s Settings Sync: Cannot determine snippets directory path');
            return;
        }

        let snippetFiles: Record<string, string>;
        try {
            const parsed = JSON.parse(remoteSnippetsJson);
            if (!this.isPlainObject(parsed)) {
                console.warn('Soloboi\'s Settings Sync: remote snippets.json is not an object');
                return;
            }

            snippetFiles = {};
            for (const [name, value] of Object.entries(parsed)) {
                if (typeof value === 'string') {
                    snippetFiles[name] = value;
                }
            }
        } catch {
            console.warn('Soloboi\'s Settings Sync: Cannot parse remote snippets.json');
            return;
        }

        this.ensureDir(snippetsDir);
        const resolvedSnippetsDir = path.resolve(snippetsDir);
        const snippetsDirPrefix = this.normalizePathForComparison(
            resolvedSnippetsDir.endsWith(path.sep) ? resolvedSnippetsDir : `${resolvedSnippetsDir}${path.sep}`
        );
        const remoteSnippetNames = new Set<string>();

        for (const [filename, content] of Object.entries(snippetFiles)) {
            const resolvedFilePath = this.resolveSnippetFilePath(snippetsDir, snippetsDirPrefix, filename);
            if (!resolvedFilePath) {
                continue;
            }

            remoteSnippetNames.add(path.basename(resolvedFilePath));
            this.writeFileIfChanged(resolvedFilePath, content);
        }

        const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
        if (!config.get<boolean>('authoritativeDownload', false)) {
            return;
        }

        const entries = fs.readdirSync(snippetsDir);
        for (const entry of entries) {
            const resolvedFilePath = this.resolveSnippetFilePath(snippetsDir, snippetsDirPrefix, entry);
            if (!resolvedFilePath || remoteSnippetNames.has(path.basename(resolvedFilePath))) {
                continue;
            }

            if (!fs.existsSync(resolvedFilePath) || !fs.statSync(resolvedFilePath).isFile()) {
                continue;
            }

            fs.unlinkSync(resolvedFilePath);
        }
    }

    /**
     * Install extensions that are in the remote list but not installed locally.
     * Returns the count of newly installed extensions.
     */
    async installMissingExtensions(remoteExtensionsJson: string): Promise<number> {
        let remoteList: { id: string }[];
        try {
            const parsed = JSON.parse(remoteExtensionsJson);
            if (!Array.isArray(parsed)) {
                console.warn('Soloboi\'s Settings Sync: remote extensions.json is not an array');
                return 0;
            }

            remoteList = parsed
                .filter(item => this.isPlainObject(item) && typeof item.id === 'string')
                .map(item => ({ id: String(item.id) }));
        } catch {
            console.warn('Soloboi\'s Settings Sync: Cannot parse remote extensions.json');
            return 0;
        }

        const ignoredIds = this.getIgnoredExtensionIds();
        const installed = new Set(
            vscode.extensions.all.map(ext => ext.id.toLowerCase())
        );

        let count = 0;
        for (const ext of remoteList) {
            const id = (ext.id || '').toLowerCase();
            if (id && !ignoredIds.has(id) && !installed.has(id)) {
                try {
                    await this.installExtensionViaCLI(ext.id);
                    count++;
                    console.log(`Soloboi\'s Settings Sync: Installed extension ${ext.id}`);
                } catch (err) {
                    console.error(`Soloboi\'s Settings Sync: Failed to install ${ext.id}`, err);
                }
            }
        }
        return count;
    }

    /**
     * Uninstall local extensions that are not in the remote list.
     * Returns the count of removed extensions.
     */
    async uninstallExtraExtensions(remoteExtensionsJson: string): Promise<number> {
        const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
        if (!config.get<boolean>('removeExtensions', false)) {
            return 0;
        }

        let remoteList: { id: string }[];
        try {
            const parsed = JSON.parse(remoteExtensionsJson);
            if (!Array.isArray(parsed)) {
                console.warn('Soloboi\'s Settings Sync: remote extensions.json is not an array');
                return 0;
            }

            remoteList = parsed
                .filter(item => this.isPlainObject(item) && typeof item.id === 'string')
                .map(item => ({ id: String(item.id) }));
        } catch {
            return 0;
        }

        const ignoredIds = this.getIgnoredExtensionIds();
        const remoteIds = new Set(remoteList.map(ext => ext.id.toLowerCase()));
        let count = 0;

        for (const ext of vscode.extensions.all) {
            if (ext.packageJSON?.isBuiltin) continue;

            const id = ext.id.toLowerCase();
            // Do not uninstall ourselves
            if (id === 'soloboi.solobois-settings-sync') continue;
            // Ignore list means "do not manage"
            if (ignoredIds.has(id)) continue;

            if (!remoteIds.has(id)) {
                try {
                    await vscode.commands.executeCommand(
                        'workbench.extensions.uninstallExtension',
                        ext.id
                    );
                    count++;
                    console.log(`Soloboi\'s Settings Sync: Uninstalled extra extension ${ext.id}`);
                } catch (err) {
                    console.error(`Soloboi\'s Settings Sync: Failed to uninstall ${ext.id}`, err);
                }
            }
        }
        return count;
    }


    portablizePaths(settingsStr: string): string { return this._paths.portablizePaths(settingsStr); }
    resolvePortablePaths(settingsStr: string): string { return this._paths.resolvePortablePaths(settingsStr); }


    /**
     * Get ignored patterns from configuration.
     */
    private getIgnoredPatterns(): string[] {
        const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
        return this.getStringArrayConfig(config, 'ignoredSettings');
    }

    private readRedactedJsonFile(filePath: string | null): string | null {
        if (!filePath || !fs.existsSync(filePath)) {
            return null;
        }

        const content = fs.readFileSync(filePath, 'utf8');
        const parsed = parseJsonc(content);
        if (parsed === null) {
            return content;
        }

        return JSON.stringify(sensitiveDataGuard.redactObject(parsed, 'private').result, null, 4);
    }

    /**
     * Aggressively sanitize JSON for use in Public Gists.
     * Removes common secret-like keys (tokens, cookies, auth, private keys, etc.) recursively.
     */
    sanitizeJsonForPublicGist(jsonText: string): string {
        return sensitiveDataGuard.redactJsonString(jsonText, 'public').result;
    }

    /**
     * Preserve ignored local keys when authoritative download mode is enabled.
     */
    private preserveIgnoredLocalSettings(localObj: any, remoteObj: any, ignoredPatterns: string[]): any {
        if (ignoredPatterns.length === 0 || !localObj || typeof localObj !== 'object' || Array.isArray(localObj)) {
            return remoteObj;
        }

        const preserved = { ...remoteObj };
        for (const [key, value] of Object.entries(localObj)) {
            if (this.shouldIgnore(key, ignoredPatterns)) {
                preserved[key] = value;
            }
        }

        return preserved;
    }

    /**
     * Check if a setting key matches any ignored pattern.
     */
    private shouldIgnore(key: string, ignoredPatterns: string[]): boolean {
        const matchGlob = (pattern: string, text: string) => {
            const regexStr = '^' + pattern.split('*').map(p => p.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&')).join('.*') + '$';
            return new RegExp(regexStr).test(text);
        };
        return ignoredPatterns.some(pattern => matchGlob(pattern, key));
    }

    /**
     * Deep merge: source values override target, nested objects are merged recursively.
     */
    private deepMerge(target: any, source: any): any {
        const isObj = (v: any) => v && typeof v === 'object' && !Array.isArray(v);

        if (!isObj(target) || !isObj(source)) {
            return source;
        }

        const result = { ...target };
        for (const key of Object.keys(source)) {
            if (isObj(result[key]) && isObj(source[key])) {
                result[key] = this.deepMerge(result[key], source[key]);
            } else {
                result[key] = source[key];
            }
        }
        return result;
    }

    /**
     * Ensure a directory exists (recursive mkdir).
     */
    private ensureDir(dirPath: string): void {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
    }

    /**
     * Write a file only when the content actually changed.
     */
    private writeFileIfChanged(filePath: string, content: string): void {
        if (fs.existsSync(filePath)) {
            const currentContent = fs.readFileSync(filePath, 'utf8');
            if (currentContent === content) {
                return;
            }
        }

        this.ensureDir(path.dirname(filePath));
        fs.writeFileSync(filePath, content, 'utf8');
    }

    private resolveSnippetFilePath(snippetsDir: string, snippetsDirPrefix: string, filename: string): string | null {
        const sanitizedFilename = path.basename(filename);
        const normalizedFilename = sanitizedFilename.toLowerCase();

        if (filename.includes('..') || sanitizedFilename.includes('..')) {
            console.warn(`Soloboi's Settings Sync: Skipping suspicious snippet filename "${filename}"`);
            return null;
        }

        if (!normalizedFilename.endsWith('.json') && !normalizedFilename.endsWith('.code-snippets')) {
            return null;
        }

        const resolvedFilePath = path.resolve(path.join(snippetsDir, sanitizedFilename));
        if (!this.normalizePathForComparison(resolvedFilePath).startsWith(snippetsDirPrefix)) {
            console.warn(`Soloboi's Settings Sync: Skipping out-of-bounds snippet filename "${filename}"`);
            return null;
        }

        return resolvedFilePath;
    }

    private normalizePathForComparison(filePath: string): string {
        return process.platform === 'win32'
            ? filePath.toLowerCase()
            : filePath;
    }
}



