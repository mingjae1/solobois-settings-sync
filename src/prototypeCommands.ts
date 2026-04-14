import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SettingsManager } from './settingsManager';
import { notify } from './notify';
import { checkMarketplaceHealth } from './prototypes/marketplaceHealthCheck';
import { runSettingsE2ETest } from './prototypes/settingsE2ETest';

type PrototypeCommandDependencies = {
    settingsManager: SettingsManager;
    outputChannel: vscode.OutputChannel;
};

export function registerPrototypeCommands(
    context: vscode.ExtensionContext,
    dependencies: PrototypeCommandDependencies
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.showDockerPathInfo', () => {
            showDockerPathInfoCommand(dependencies);
        }),
        vscode.commands.registerCommand('soloboisSettingsSync.checkExtensionHealth', async () => {
            await checkExtensionHealthCommand(dependencies);
        }),
        vscode.commands.registerCommand('soloboisSettingsSync.runSettingsE2ETest', async () => {
            await runSettingsE2ETestCommand(dependencies);
        }),
    );
}

function showDockerPathInfoCommand(dependencies: PrototypeCommandDependencies): void {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const config = vscode.workspace.getConfiguration('soloboisSettingsSync');
    const strategy = config.get<string>('pathStrategy', 'auto');

    const settingsDir = dependencies.settingsManager.getUserSettingsDir();
    const extensionsDir = dependencies.settingsManager.getExtensionsDir();

    const dockerSettingsPath = homeDir ? path.join(homeDir, 'data', 'User') : '';
    const dockerExtPath = homeDir ? path.join(homeDir, 'extensions') : '';

    const cgroupSignal = (() => {
        try {
            if (fs.existsSync('/proc/self/cgroup')) {
                const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8');
                return cgroup.includes('docker') || cgroup.includes('kubepods');
            }
        } catch { /* non-Linux or permission error */ }
        return false;
    })();
    const isDockerEnv =
        process.env['LSIO_FIRST_PARTY'] !== undefined ||
        process.env['DOCKER_RUNNING'] === 'true' ||
        process.env['REMOTE_CONTAINERS'] === 'true' ||
        fs.existsSync('/.dockerenv') ||
        cgroupSignal;

    const usingDockerSettings = !!dockerSettingsPath && settingsDir === dockerSettingsPath;
    const usingDockerExt = !!dockerExtPath && extensionsDir === dockerExtPath;
    const dockerSettingsExists = !!dockerSettingsPath && fs.existsSync(dockerSettingsPath);
    const dockerExtExists = !!dockerExtPath && fs.existsSync(dockerExtPath);

    dependencies.outputChannel.clear();
    dependencies.outputChannel.appendLine('=== Docker Environment Info ===');
    dependencies.outputChannel.appendLine('');
    dependencies.outputChannel.appendLine('[Strategy]');
    dependencies.outputChannel.appendLine(`  pathStrategy setting: ${strategy}`);
    dependencies.outputChannel.appendLine(`  Container detected  : ${isDockerEnv ? 'Yes (/.dockerenv or env var)' : 'No'}`);
    dependencies.outputChannel.appendLine('');
    dependencies.outputChannel.appendLine('[Active Paths]');
    dependencies.outputChannel.appendLine(`  Settings Dir  : ${settingsDir ?? '(not found)'}`);
    dependencies.outputChannel.appendLine(`  Extensions Dir: ${extensionsDir ?? '(not found)'}`);
    dependencies.outputChannel.appendLine('');
    dependencies.outputChannel.appendLine('[Docker Paths (LinuxServer.io code-server)]');
    dependencies.outputChannel.appendLine(`  ~/data/User  : ${dockerSettingsPath || '(home not found)'}  [exists: ${dockerSettingsExists}]`);
    dependencies.outputChannel.appendLine(`  ~/extensions : ${dockerExtPath || '(home not found)'}  [exists: ${dockerExtExists}]`);
    dependencies.outputChannel.appendLine('');
    dependencies.outputChannel.appendLine('[Status]');
    dependencies.outputChannel.appendLine(`  Using Docker settings path  : ${usingDockerSettings ? 'Yes' : 'No'}`);
    dependencies.outputChannel.appendLine(`  Using Docker extensions path: ${usingDockerExt ? 'Yes' : 'No'}`);
    dependencies.outputChannel.appendLine('');
    if (!usingDockerSettings && (dockerSettingsExists || isDockerEnv)) {
        dependencies.outputChannel.appendLine('[Tip] Docker paths detected but not in use.');
        dependencies.outputChannel.appendLine('  Set "soloboisSettingsSync.pathStrategy": "docker" in your settings to force Docker mode.');
    }
    dependencies.outputChannel.show(true);

    const statusMsg = usingDockerSettings || usingDockerExt
        ? 'Docker paths are active.'
        : isDockerEnv || dockerSettingsExists
            ? 'Docker paths exist but are not active. Set pathStrategy to "docker" to use them.'
            : 'No Docker environment detected.';

    void notify.info(statusMsg, 'View Report').then(sel => {
        if (sel === 'View Report') { dependencies.outputChannel.show(true); }
    });
}

async function checkExtensionHealthCommand(dependencies: PrototypeCommandDependencies): Promise<void> {
    const installedIds = getInstalledExtensionIds(dependencies.settingsManager).slice(0, 20);
    const defaultIds = installedIds.length > 0 ? installedIds.join(',') : 'soloboi.solobois-settings-sync';
    const input = await vscode.window.showInputBox({
        title: 'Check Marketplace Health',
        prompt: 'Extension IDs to check (comma-separated, up to 20 recommended).',
        value: defaultIds
    });
    if (input === undefined) {
        return;
    }

    const ids = input
        .split(',')
        .map(id => id.trim())
        .filter(id => id.includes('.') && id.length > 0);

    if (ids.length === 0) {
        void notify.warn('No valid extension IDs were provided.');
        return;
    }

    const targets = ids.map(id => {
        const dot = id.indexOf('.');
        return {
            publisher: id.slice(0, dot),
            name: id.slice(dot + 1)
        };
    });

    const results = await checkMarketplaceHealth({ extensions: targets });
    dependencies.outputChannel.clear();
    dependencies.outputChannel.appendLine('=== Marketplace Health Check ===');
    dependencies.outputChannel.appendLine(`Checked: ${results.length}`);
    dependencies.outputChannel.appendLine('');
    for (const row of results) {
        dependencies.outputChannel.appendLine(
            `${row.extensionId} | ${row.status} | http=${row.httpStatusCode} | ${row.url}`
        );
    }
    dependencies.outputChannel.show(true);
}

async function runSettingsE2ETestCommand(dependencies: PrototypeCommandDependencies): Promise<void> {
    const settingKey = await vscode.window.showInputBox({
        title: 'Run Settings E2E Test',
        prompt: 'Setting key to test in isolated VS Code launch.',
        value: 'editor.fontSize'
    });
    if (!settingKey) {
        return;
    }

    const valueRaw = await vscode.window.showInputBox({
        title: 'Run Settings E2E Test',
        prompt: 'Setting value (JSON literal or plain string).',
        value: '14'
    });
    if (valueRaw === undefined) {
        return;
    }

    let parsedValue: unknown = valueRaw;
    try {
        parsedValue = JSON.parse(valueRaw);
    } catch {
        parsedValue = valueRaw;
    }

    const timeoutRaw = await vscode.window.showInputBox({
        title: 'Run Settings E2E Test',
        prompt: 'Launch duration in milliseconds before forced close.',
        value: '8000'
    });
    if (timeoutRaw === undefined) {
        return;
    }
    const timeoutMs = Number(timeoutRaw);
    const safeTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 8000;

    const result = await runSettingsE2ETest({
        vscodeExecutablePath: process.execPath,
        settings: { [settingKey]: parsedValue },
        launchTimeoutMs: safeTimeout
    });

    dependencies.outputChannel.clear();
    dependencies.outputChannel.appendLine('=== Settings E2E Test ===');
    dependencies.outputChannel.appendLine(`Executable: ${process.execPath}`);
    dependencies.outputChannel.appendLine(`Setting: ${settingKey} = ${JSON.stringify(parsedValue)}`);
    dependencies.outputChannel.appendLine(`Exit code: ${String(result.exitCode)}`);
    dependencies.outputChannel.appendLine(`stderr length: ${result.stderr.length}`);
    dependencies.outputChannel.appendLine(`error-log matches: ${result.errorLogMatches.length}`);
    for (const line of result.errorLogMatches) {
        dependencies.outputChannel.appendLine(`- ${line}`);
    }
    dependencies.outputChannel.show(true);

    if (result.errorLogMatches.length > 0) {
        void notify.warn('Settings E2E test finished with error-like log lines.', 'View Report')
            .then(sel => {
                if (sel === 'View Report') {
                    dependencies.outputChannel.show(true);
                }
            });
    } else {
        void notify.info('Settings E2E test finished.', 'View Report')
            .then(sel => {
                if (sel === 'View Report') {
                    dependencies.outputChannel.show(true);
                }
            });
    }
}

function getInstalledExtensionIds(settingsManager: SettingsManager): string[] {
    try {
        const raw = settingsManager.readInstalledExtensions();
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed
            .map(item => (item && typeof item.id === 'string' ? item.id : ''))
            .filter((id: string) => id.includes('.'));
    } catch {
        return [];
    }
}
