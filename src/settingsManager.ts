import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Manages reading/writing local VS Code settings files, keybindings, and extensions.
 */
export class SettingsManager {
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
        const ignored = config.get<string[]>('ignoredExtensions', []);
        return new Set(
            ignored
                .map(id => (id || '').trim().toLowerCase())
                .filter(id => !!id)
        );
    }

    /**
     * Get the VS Code User settings directory based on the current OS.
     */
    getUserSettingsDir(): string | null {
        const isWindows = process.platform === 'win32';
        const isMac = process.platform === 'darwin';

        // Detect app folder name (default to Antigravity, fallback to Code/VSCodium if not found)
        const appName = vscode.env.appName || "";
        let folderName = 'Antigravity';
        
        if (appName.includes('VSCodium')) {
            folderName = 'VSCodium';
        } else if (appName.includes('Code')) {
            folderName = 'Code';
        }

        if (isWindows && process.env.APPDATA) {
            return path.join(process.env.APPDATA, folderName, 'User');
        } else if (isMac && process.env.HOME) {
            return path.join(process.env.HOME, 'Library', 'Application Support', folderName, 'User');
        } else if (process.env.HOME) {
            return path.join(process.env.HOME, '.config', folderName.toLowerCase(), 'User');
        }
        return null;
    }

    /**
     * Get the path to settings.json
     */
    getSettingsPath(): string | null {
        const dir = this.getUserSettingsDir();
        return dir ? path.join(dir, 'settings.json') : null;
    }

    /**
     * Get the path to keybindings.json
     */
    getKeybindingsPath(): string | null {
        const dir = this.getUserSettingsDir();
        return dir ? path.join(dir, 'keybindings.json') : null;
    }

    // ── Read Operations ──────────────────────────────────────────────

    /**
     * Read local settings.json content as a string.
     * Merges all installed extension settings (including defaults) so that
     * the Gist always contains every extension configuration value.
     */
    readLocalSettings(): string | null {
        const filePath = this.getSettingsPath();
        if (!filePath || !fs.existsSync(filePath)) {
            return null;
        }
        const content = fs.readFileSync(filePath, 'utf8');
        const fileObj = this.parseJsonc(content);
        if (!fileObj) return content;

        // Collect all extension configuration values (including defaults)
        const extSettings = this.readAllExtensionSettings();

        // Extension defaults first, then file settings override
        const merged = { ...extSettings, ...fileObj };

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
        return this.portablizePaths(JSON.stringify(merged, null, 4));
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
        return this.parseJsonc(content) || {};
    }

    /**
     * Get the extensions directory for the current editor.
     * Checks ~/.antigravity/extensions/ first, then falls back to ~/.vscode/extensions/
     */
    getExtensionsDir(): string | null {
        const homeDir = process.env.HOME || process.env.USERPROFILE;
        if (!homeDir) return null;

        // Try Antigravity first, then VS Code
        const candidates = [
            path.join(homeDir, '.antigravity', 'extensions'),
            path.join(homeDir, '.vscode', 'extensions'),
        ];

        for (const dir of candidates) {
            if (fs.existsSync(dir)) {
                return dir;
            }
        }
        return null;
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

        // ── Approach 1: VS Code API ─────────────────────────────────
        let apiExtCount = 0;
        for (const ext of vscode.extensions.all) {
            const publisher = (ext.packageJSON?.publisher || '').toLowerCase();
            if (publisher === 'vscode') continue;

            const config = ext.packageJSON?.contributes?.configuration;
            if (!config) continue;

            apiExtCount++;
            const configs = Array.isArray(config) ? config : [config];

            for (const cfg of configs) {
                const properties = cfg.properties;
                if (!properties) continue;

                for (const key of Object.keys(properties)) {
                    if (processedKeys.has(key)) continue;
                    processedKeys.add(key);
                    const value = vscode.workspace.getConfiguration().get(key);
                    if (value !== undefined) {
                        allSettings[key] = value;
                    }
                }
            }
        }

        // ── Approach 2: Disk scan (fallback) ────────────────────────
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
                            const properties = cfg.properties;
                            if (!properties) continue;

                            for (const key of Object.keys(properties)) {
                                if (processedKeys.has(key)) continue;
                                processedKeys.add(key);

                                // Try VS Code API first, fall back to default from package.json
                                const apiValue = vscode.workspace.getConfiguration().get(key);
                                if (apiValue !== undefined) {
                                    allSettings[key] = apiValue;
                                } else if (properties[key].default !== undefined) {
                                    allSettings[key] = properties[key].default;
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

    /**
     * Get the Antigravity data directory (~/.gemini/antigravity/)
     */
    getAntigravityDataDir(): string | null {
        const homeDir = process.env.HOME || process.env.USERPROFILE;
        if (!homeDir) return null;
        return path.join(homeDir, '.gemini', 'antigravity');
    }

    /**
     * Get the path to Antigravity internal settings (mcp_config.json)
     */
    getAntigravityConfigPath(): string | null {
        const dir = this.getAntigravityDataDir();
        return dir ? path.join(dir, 'mcp_config.json') : null;
    }

    /**
     * Get the path to browserAllowlist.txt
     */
    getBrowserAllowlistPath(): string | null {
        const dir = this.getAntigravityDataDir();
        return dir ? path.join(dir, 'browserAllowlist.txt') : null;
    }

    /**
     * Get the snippets directory path
     */
    getSnippetsDir(): string | null {
        const dir = this.getUserSettingsDir();
        return dir ? path.join(dir, 'snippets') : null;
    }

    /**
     * Get the backup directory
     */
    getBackupDir(): string | null {
        const homeDir = process.env.HOME || process.env.USERPROFILE;
        if (!homeDir) return null;
        return path.join(homeDir, '.antigravity-sync-backup');
    }

    /**
     * Read local Antigravity config (mcp_config.json).
     */
    readAntigravityConfig(): string | null {
        const filePath = this.getAntigravityConfigPath();
        if (!filePath || !fs.existsSync(filePath)) {
            return null;
        }
        return fs.readFileSync(filePath, 'utf8');
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
                if (fs.statSync(filePath).isFile()) {
                    snippetFiles[entry] = fs.readFileSync(filePath, 'utf8');
                }
            }
        }

        if (Object.keys(snippetFiles).length === 0) {
            return null;
        }
        return JSON.stringify(snippetFiles, null, 2);
    }

    // ── Write Operations ─────────────────────────────────────────────

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
                    fs.copyFileSync(path.join(snippetsDir, entry), path.join(backupSnippetsDir, entry));
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

        const remoteObj = this.parseJsonc(resolvedContent);
        if (!remoteObj) {
            throw new Error('Cannot parse remote settings.json');
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
            localObj = this.parseJsonc(localContent) ?? {};
        }

        const merged = this.deepMerge(localObj, remoteObj);
        this.ensureDir(path.dirname(filePath));
        fs.writeFileSync(filePath, JSON.stringify(merged, null, 4), 'utf8');
    }

    /**
     * Write content to keybindings.json (full overwrite).
     */
    writeLocalKeybindings(content: string): void {
        const filePath = this.getKeybindingsPath();
        if (!filePath) {
            throw new Error('Cannot determine keybindings.json path');
        }
        this.ensureDir(path.dirname(filePath));
        fs.writeFileSync(filePath, content, 'utf8');
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
        this.ensureDir(path.dirname(filePath));
        fs.writeFileSync(filePath, content, 'utf8');
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
        this.ensureDir(path.dirname(filePath));
        fs.writeFileSync(filePath, content, 'utf8');
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
            snippetFiles = JSON.parse(remoteSnippetsJson);
        } catch {
            console.warn('Soloboi\'s Settings Sync: Cannot parse remote snippets.json');
            return;
        }

        this.ensureDir(snippetsDir);

        for (const [filename, content] of Object.entries(snippetFiles)) {
            const ext = path.extname(filename).toLowerCase();
            if (ext === '.json' || ext === '.code-snippets') {
                const filePath = path.join(snippetsDir, filename);
                fs.writeFileSync(filePath, content, 'utf8');
            }
        }
    }

    /**
     * Install extensions that are in the remote list but not installed locally.
     * Returns the count of newly installed extensions.
     */
    async installMissingExtensions(remoteExtensionsJson: string): Promise<number> {
        let remoteList: { id: string }[];
        try {
            remoteList = JSON.parse(remoteExtensionsJson);
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
                    await vscode.commands.executeCommand(
                        'workbench.extensions.installExtension',
                        ext.id
                    );
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
            remoteList = JSON.parse(remoteExtensionsJson);
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

    // ── Portable Path System ─────────────────────────────────────────

    /**
     * Build a list of path variable mappings for the current machine.
     * Ordered from MOST SPECIFIC to LEAST SPECIFIC to prevent partial matches.
     */
    private getPathVariables(): Array<{ variable: string; value: string }> {
        const vars: Array<{ variable: string; value: string }> = [];
        const userSettingsDir = this.getUserSettingsDir();
        const homeDir = process.env.HOME || process.env.USERPROFILE || '';

        // 1. globalStorage (most specific)
        if (userSettingsDir) {
            const globalStorageDir = path.join(userSettingsDir, 'globalStorage');
            vars.push({ variable: '${globalStorage}', value: globalStorageDir });
        }

        // 2. User settings dir (e.g., %APPDATA%/Antigravity/User)
        if (userSettingsDir) {
            vars.push({ variable: '${userSettingsDir}', value: userSettingsDir });
        }

        // 3. AppData / Application Support
        if (process.platform === 'win32' && process.env.APPDATA) {
            vars.push({ variable: '${appData}', value: process.env.APPDATA });
        } else if (process.platform === 'darwin' && process.env.HOME) {
            vars.push({ variable: '${appData}', value: path.join(process.env.HOME, 'Library', 'Application Support') });
        } else if (process.env.HOME) {
            vars.push({ variable: '${appData}', value: path.join(process.env.HOME, '.config') });
        }

        // 4. User home (least specific)
        if (homeDir) {
            vars.push({ variable: '${userHome}', value: homeDir });
        }

        return vars;
    }

    /**
     * Replace machine-specific absolute paths with portable ${variables}.
     * Used during UPLOAD to make settings.json cross-machine compatible.
     *
     * JSON.stringify produces different escape levels:
     *   - Raw path value "C:\Users" in an object becomes "C:\\Users" in JSON output
     *   - Settings values that already contain "C:\\Users" become "C:\\\\Users" in JSON output
     * We must handle all these variants, replacing the longest (most-escaped) first.
     */
    portablizePaths(settingsStr: string): string {
        const vars = this.getPathVariables();
        let result = settingsStr;

        for (const { variable, value } of vars) {
            if (!value) continue;

            // Quad-escaped: settings.json stores "C:\\Users", JSON.stringify makes "C:\\\\Users"
            const quadEscaped = value.replace(/\\/g, '\\\\\\\\');
            // Double-escaped: raw path "C:\Users" → JSON.stringify → "C:\\Users"
            const doubleEscaped = value.replace(/\\/g, '\\\\');
            // Forward-slash variant
            const forwardSlash = value.replace(/\\/g, '/');

            // Replace from most-escaped to least-escaped (order matters!)
            result = result.split(quadEscaped).join(variable);
            result = result.split(doubleEscaped).join(variable);
            if (forwardSlash !== value) {
                result = result.split(forwardSlash).join(variable);
            }
            result = result.split(value).join(variable);
        }

        return result;
    }

    /**
     * Resolve portable ${variables} back to local machine paths.
     * Used during DOWNLOAD to restore machine-specific paths.
     *
     * Since portablizePaths replaces quad-escaped paths with ${variable},
     * we must restore ${variable} back to quad-escaped paths to maintain
     * valid JSON with correctly escaped backslash strings.
     */
    resolvePortablePaths(settingsStr: string): string {
        const vars = this.getPathVariables();
        let result = settingsStr;

        // Resolve in REVERSE order (least specific first) to avoid
        // replacing ${userHome} inside ${globalStorage}'s expanded path
        for (const { variable, value } of [...vars].reverse()) {
            if (!value) continue;

            // Restore to double-escaped form (standard JSON for paths like "C:\\Users")
            const doubleEscaped = value.replace(/\\/g, '\\\\');
            result = result.split(variable).join(doubleEscaped);
        }

        return result;
    }

    // ── Utilities ────────────────────────────────────────────────────

    /**
     * Get ignored patterns from configuration.
     */
    private getIgnoredPatterns(): string[] {
        const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
        return config.get<string[]>('ignoredSettings', []);
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
     * Parse JSONC (JSON with comments and trailing commas) by stripping them first.
     */
    private parseJsonc(content: string): any | null {
        try {
            // A more robust but simple comment remover that respects strings (to avoid breaking URLs)
            let isInsideString = false;
            let isInsideSingleLineComment = false;
            let isInsideMultiLineComment = false;
            let cleaned = '';

            for (let i = 0; i < content.length; i++) {
                const char = content[i];
                const nextChar = content[i + 1];

                if (isInsideSingleLineComment) {
                    if (char === '\n') {
                        isInsideSingleLineComment = false;
                        cleaned += char;
                    }
                    continue;
                }

                if (isInsideMultiLineComment) {
                    if (char === '*' && nextChar === '/') {
                        isInsideMultiLineComment = false;
                        i++; // skip /
                    }
                    continue;
                }

                if (isInsideString) {
                    cleaned += char;
                    if (char === '"' && content[i - 1] !== '\\') {
                        isInsideString = false;
                    }
                    continue;
                }

                if (char === '"') {
                    isInsideString = true;
                    cleaned += char;
                    continue;
                }

                if (char === '/' && nextChar === '/') {
                    isInsideSingleLineComment = true;
                    i++;
                    continue;
                }

                if (char === '/' && nextChar === '*') {
                    isInsideMultiLineComment = true;
                    i++;
                    continue;
                }

                cleaned += char;
            }

            // Strip trailing commas before } or ]
            cleaned = cleaned.replace(/,\s*([\]}])/g, '$1');
            const trimmed = cleaned.trim();
            if (!trimmed) { return {}; }
            return JSON.parse(trimmed);
        } catch (err: any) {
            console.error('Antigravity Sync: JSONC Parse Error', err);
            return null;
        }
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
}
