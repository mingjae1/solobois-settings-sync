import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';

import { ExtensionUpdateInfo } from '../marketplaceChecker';

export function safeUnlink(filePath: string): void {
    try {
        fs.unlinkSync(filePath);
    } catch {
        // ignore cleanup errors
    }
}

export function getExtensionLocalPath(id: string, version: string): string {
    const extDir = path.join(os.homedir(), '.vscode', 'extensions');
    return path.join(extDir, `${id.toLowerCase()}-${version}`);
}

export function downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const transport = parsed.protocol === 'http:' ? http : https;
        const file = fs.createWriteStream(destPath);

        const req = transport.get(url, (res: http.IncomingMessage) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                file.destroy();
                safeUnlink(destPath);
                const redirectUrl = new URL(res.headers.location, parsed).toString();
                downloadFile(redirectUrl, destPath).then(resolve, reject);
                return;
            }

            if (res.statusCode !== 200) {
                file.destroy();
                safeUnlink(destPath);
                reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
                return;
            }

            res.pipe(file);
            file.on('finish', () => file.close(() => resolve()));
        });

        req.on('error', (err: Error) => {
            file.destroy();
            safeUnlink(destPath);
            reject(err);
        });
    });
}

/**
 * Downloads a VSIX from the given URL to a temp file, installs it via VS Code's
 * extension API, then cleans up the temp file.
 */
export async function installFromVsixUrl(
    upd: ExtensionUpdateInfo,
    log: vscode.OutputChannel,
    directVsixUrl?: string
): Promise<void> {
    let vsixUrl = (directVsixUrl || '').trim();
    let vsixFile = '';

    if (!vsixUrl) {
        log.appendLine(`[VSIX Install] No direct VSIX URL provided -> skipping ${upd.id}`);
        return;
    }

    try {
        const parsed = new URL(vsixUrl);
        vsixFile = path.basename(parsed.pathname) || `${upd.id.replace(/\./g, '-')}-${upd.latestVersion}.vsix`;
    } catch {
        vsixFile = `${upd.id.replace(/\./g, '-')}-${upd.latestVersion}.vsix`;
    }

    const tmpPath = path.join(os.tmpdir(), `soloboi-sync-${vsixFile}`);
    const sourceLabel = 'direct URL';
    log.appendLine(`[VSIX Install] Downloading ${upd.id}@${upd.latestVersion} from ${sourceLabel}...`);

    try {
        await downloadFile(vsixUrl, tmpPath);
        await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(tmpPath));
        log.appendLine(`[VSIX Install] Installed ${upd.id}@${upd.latestVersion}`);
    } finally {
        safeUnlink(tmpPath);
    }
}
