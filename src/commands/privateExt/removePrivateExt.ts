import * as vscode from 'vscode';
import type { AppContext } from '../../context';
import { notify } from '../../notify';

export function registerRemovePrivateExtCommand(
    context: vscode.ExtensionContext,
    ctx: AppContext
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.removePrivateExtension', async (extId?: string) => {
            const cfg = vscode.workspace.getConfiguration('soloboisSettingsSync');
            const existing: any[] = cfg.get('privateExtensions', []);

            const target = extId ?? await vscode.window.showQuickPick(
                existing.map((e: any) => ({ label: e.id, description: `v${e.version}` })),
                { title: 'Remove Private Extension', placeHolder: 'Select extension to remove' }
            ).then(sel => sel?.label);

            if (!target) { return; }

            const updated = existing.filter((e: any) => e.id !== target);
            await cfg.update('privateExtensions', updated, vscode.ConfigurationTarget.Global);
            void notify.info(`"${target}" removed from private extensions.`);
            ctx.treeProvider.refresh();
        })
    );
}
