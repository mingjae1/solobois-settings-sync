import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolves all file system paths used by the sync extension.
 * Handles platform detection, Docker/code-server environments, and path portabilization.
 */
export class SettingsPathResolver {

    log(msg: string): void {
        console.log(msg);
    }

    detectDockerEnvironment(): boolean {
        // Fast env-var checks first (no I/O)
        if (
            process.env['LSIO_FIRST_PARTY'] !== undefined ||
            process.env['DOCKER_RUNNING'] === 'true' ||
            process.env['REMOTE_CONTAINERS'] === 'true'
        ) {
            return true;
        }

        // /.dockerenv: standard Docker file present in all Docker containers
        if (fs.existsSync('/.dockerenv')) {
            return true;
        }

        // /proc/self/cgroup: reliable on cgroup v1 (Docker, Kubernetes)
        try {
            if (fs.existsSync('/proc/self/cgroup')) {
                const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8');
                if (cgroup.includes('docker') || cgroup.includes('kubepods')) {
                    return true;
                }
            }
        } catch {
            // Non-Linux or permission error — silent fallback
        }

        return false;
    }

    getPathStrategy(): 'auto' | 'docker' | 'standard' {
        const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
        const raw = (config.get<string>('pathStrategy', 'auto') ?? 'auto').toLowerCase();
        if (raw === 'docker' || raw === 'standard') { return raw; }
        return 'auto';
    }

    /**
     * Get the VS Code User settings directory based on the current OS.
     * Respects soloboisSettingsSync.userDataDir override.
     * Uses soloboisSettingsSync.pathStrategy to control Docker path priority:
     *   - 'auto'     : prefer standard path; use Docker path (~/data/User) if detected or standard missing
     *   - 'docker'   : always use ~/data/User (LinuxServer.io code-server)
     *   - 'standard' : always use standard OS path; never Docker fallback
     */
    getUserSettingsDir(): string | null {
        const homeDir = process.env.HOME || process.env.USERPROFILE;

        // Honor explicit user override
        const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
        const customDir = (config.get<string>('userDataDir') || '').trim();
        if (customDir) {
            return customDir.startsWith('~/') && homeDir
                ? path.join(homeDir, customDir.slice(2))
                : customDir;
        }

        const isWindows = process.platform === 'win32';
        const isMac = process.platform === 'darwin';

        const appName = vscode.env.appName || '';
        let folderName = 'Antigravity';
        if (appName.includes('VSCodium')) { folderName = 'VSCodium'; }
        else if (appName.includes('Code')) { folderName = 'Code'; }

        if (isWindows && process.env.APPDATA) {
            return path.join(process.env.APPDATA, folderName, 'User');
        } else if (isMac && homeDir) {
            return path.join(homeDir, 'Library', 'Application Support', folderName, 'User');
        } else if (homeDir) {
            const strategy = this.getPathStrategy();
            const isDocker = this.detectDockerEnvironment();
            const standard = path.join(homeDir, '.config', folderName, 'User');
            const dockerPath = path.join(homeDir, 'data', 'User');
            const codeServerPath = path.join(homeDir, '.local', 'share', 'code-server', 'User');

            let chosen: string;
            if (strategy === 'docker' || (strategy === 'auto' && isDocker)) {
                chosen = fs.existsSync(dockerPath) ? dockerPath
                    : fs.existsSync(codeServerPath) ? codeServerPath
                    : dockerPath;
            } else if (strategy === 'standard') {
                chosen = standard;
            } else {
                chosen = fs.existsSync(standard) ? standard
                    : fs.existsSync(codeServerPath) ? codeServerPath
                    : fs.existsSync(dockerPath) ? dockerPath
                    : standard;
            }

            this.log(`[PathResolver] Settings dir: ${chosen} (strategy=${strategy}, docker=${isDocker})`);
            return chosen;
        }
        return null;
    }

    /**
     * Get the extensions directory for the current editor.
     * Respects soloboisSettingsSync.extensionsDir override.
     */
    getExtensionsDir(): string | null {
        const homeDir = process.env.HOME || process.env.USERPROFILE;

        const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
        const customDir = (config.get<string>('extensionsDir') || '').trim();
        if (customDir) {
            if (!customDir.startsWith('~/')) { return customDir; }
            if (!homeDir) { return null; }
            return path.join(homeDir, customDir.slice(2));
        }

        if (!homeDir) { return null; }

        const strategy = this.getPathStrategy();
        const isDocker = this.detectDockerEnvironment();
        const dockerExt = path.join(homeDir, 'extensions');
        const codeServerExt = path.join(homeDir, '.local', 'share', 'code-server', 'extensions');

        let chosen: string | null;
        if (strategy === 'docker' || (strategy === 'auto' && isDocker)) {
            chosen = fs.existsSync(dockerExt) ? dockerExt
                : fs.existsSync(codeServerExt) ? codeServerExt
                : dockerExt;
        } else {
            const standardCandidates = strategy === 'standard'
                ? [
                    path.join(homeDir, '.antigravity', 'extensions'),
                    path.join(homeDir, '.vscode', 'extensions'),
                    codeServerExt,
                ]
                : [
                    path.join(homeDir, '.antigravity', 'extensions'),
                    path.join(homeDir, '.vscode', 'extensions'),
                    codeServerExt,
                    dockerExt,
                ];
            chosen = standardCandidates.find(dir => fs.existsSync(dir)) ?? null;
        }

        this.log(`[PathResolver] Extensions dir: ${chosen} (strategy=${strategy}, docker=${isDocker})`);
        return chosen;
    }

    getSettingsPath(): string | null {
        const dir = this.getUserSettingsDir();
        return dir ? path.join(dir, 'settings.json') : null;
    }

    getKeybindingsPath(): string | null {
        const dir = this.getUserSettingsDir();
        return dir ? path.join(dir, 'keybindings.json') : null;
    }

    getSnippetsDir(): string | null {
        const dir = this.getUserSettingsDir();
        return dir ? path.join(dir, 'snippets') : null;
    }

    getBackupDir(): string | null {
        const homeDir = process.env.HOME || process.env.USERPROFILE;
        if (!homeDir) return null;
        return path.join(homeDir, '.antigravity-sync-backup');
    }

    getAntigravityDataDir(): string | null {
        const homeDir = process.env.HOME || process.env.USERPROFILE;
        if (!homeDir) return null;
        return path.join(homeDir, '.gemini', 'antigravity');
    }

    getAntigravityConfigPath(): string | null {
        const dir = this.getAntigravityDataDir();
        return dir ? path.join(dir, 'mcp_config.json') : null;
    }

    getBrowserAllowlistPath(): string | null {
        const dir = this.getAntigravityDataDir();
        return dir ? path.join(dir, 'browserAllowlist.txt') : null;
    }

    getAdditionalFilePaths(): string[] {
        const homeDir = process.env.HOME || process.env.USERPROFILE || '';
        const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
        const entries = config.get<string[]>('additionalFiles') || [];
        const resolvedExisting = entries
            .map(p => (p.startsWith('~/') && homeDir) ? path.join(homeDir, p.slice(2)) : p)
            .filter(p => fs.existsSync(p));

        const unique: string[] = [];
        const seenBasenames = new Set<string>();
        for (const filePath of resolvedExisting) {
            const basename = path.basename(filePath);
            if (seenBasenames.has(basename)) {
                console.warn(`[SettingsSync] Duplicate basename in additionalFiles: ${basename} (skipping ${filePath})`);
                continue;
            }
            seenBasenames.add(basename);
            unique.push(filePath);
        }
        return unique;
    }

    /**
     * Build a list of path variable mappings for the current machine.
     * Ordered from MOST SPECIFIC to LEAST SPECIFIC to prevent partial matches.
     */
    private getPathVariables(): Array<{ variable: string; value: string }> {
        const vars: Array<{ variable: string; value: string }> = [];
        const userSettingsDir = this.getUserSettingsDir();
        const homeDir = process.env.HOME || process.env.USERPROFILE || '';

        if (userSettingsDir) {
            const globalStorageDir = path.join(userSettingsDir, 'globalStorage');
            vars.push({ variable: '${globalStorage}', value: globalStorageDir });
        }
        if (userSettingsDir) {
            vars.push({ variable: '${userSettingsDir}', value: userSettingsDir });
        }

        if (process.platform === 'win32' && process.env.APPDATA) {
            vars.push({ variable: '${appData}', value: process.env.APPDATA });
        } else if (process.platform === 'darwin' && process.env.HOME) {
            vars.push({ variable: '${appData}', value: path.join(process.env.HOME, 'Library', 'Application Support') });
        } else if (process.env.HOME) {
            vars.push({ variable: '${appData}', value: path.join(process.env.HOME, '.config') });
        }

        if (homeDir) {
            vars.push({ variable: '${userHome}', value: homeDir });
        }

        return vars;
    }

    portablizePaths(settingsStr: string): string {
        const vars = this.getPathVariables();
        let result = settingsStr;

        for (const { variable, value } of vars) {
            if (!value) continue;

            const quadEscaped = value.replace(/\\/g, '\\\\\\\\');
            const doubleEscaped = value.replace(/\\/g, '\\\\');
            const forwardSlash = value.replace(/\\/g, '/');

            result = result.split(quadEscaped).join(variable);
            result = result.split(doubleEscaped).join(variable);
            if (forwardSlash !== value) {
                result = result.split(forwardSlash).join(variable);
            }
            result = result.split(value).join(variable);
        }

        return result;
    }

    resolvePortablePaths(settingsStr: string): string {
        const vars = this.getPathVariables();
        let result = settingsStr;

        for (const { variable, value } of [...vars].reverse()) {
            if (!value) continue;
            const doubleEscaped = value.replace(/\\/g, '\\\\');
            result = result.split(variable).join(doubleEscaped);
        }

        return result;
    }
}
