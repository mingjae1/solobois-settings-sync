import * as vscode from 'vscode';
import type { AppContext } from '../../context';
import { notify } from '../../notify';
import { checkMarketplaceForPlatform } from '../../marketplaceChecker';
import {
    getAutoDetectOptions,
    getSafePrivateExtensions,
    mergeDetectedPrivateExtension,
    normalizePrivateExtensionId,
    type PrivateExtensionEntry
} from '../../privateExtensions/registry';

export function registerAutoDetectPrivateExtCommand(
    context: vscode.ExtensionContext,
    ctx: AppContext
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('soloboisSettingsSync.autoDetectPrivateExtensions', async () => {
            const cfg = vscode.workspace.getConfiguration('soloboisSettingsSync');
            const options = getAutoDetectOptions(cfg);
            const existing = getSafePrivateExtensions(cfg);
            const existingById = new Map(existing.map(e => [normalizePrivateExtensionId(e.id), e]));

            const installed = vscode.extensions.all
                .filter(ext => !ext.id.startsWith('vscode.') && !ext.packageJSON?.isBuiltin)
                .map(ext => ({ id: ext.id, version: ext.packageJSON?.version ?? '0.0.0' }));

            if (installed.length === 0) {
                void notify.info('No user extensions found.');
                return;
            }

            const availability = await checkMarketplaceForPlatform(
                installed.map(ext => normalizePrivateExtensionId(ext.id)),
                ctx.platform
            );

            const candidates = installed.filter(
                ext => (availability.get(normalizePrivateExtensionId(ext.id)) ?? 'unknown') === 'unavailable'
            );
            if (candidates.length === 0) {
                void notify.info('No private extension candidates detected.');
                return;
            }

            const proposals = candidates.map(candidate => {
                const existingEntry = existingById.get(normalizePrivateExtensionId(candidate.id));
                const merged = mergeDetectedPrivateExtension(existingEntry, candidate, options);
                return { candidate, existingEntry, merged };
            }).filter(p => p.merged.action !== 'skip');

            if (proposals.length === 0) {
                void notify.info('Auto-detect found no changes to apply.');
                return;
            }

            let selected = proposals;
            if (options.requireConfirm) {
                const picks = proposals.map(p => ({
                    label: p.candidate.id,
                    description: `${p.existingEntry ? 'update' : 'add'} | v${p.existingEntry?.version ?? '-'} -> v${p.candidate.version}`,
                    detail: p.existingEntry
                        ? 'Existing entry will be merged with auto-detect rules.'
                        : 'New private extension entry will be added.',
                    picked: true,
                    proposal: p
                }));

                const chosen = await vscode.window.showQuickPick(picks, {
                    title: `Auto-detect Private Extensions (${picks.length} candidate changes)`,
                    placeHolder: 'Select entries to apply',
                    canPickMany: true
                });

                if (!chosen || chosen.length === 0) { return; }
                selected = chosen.map(item => item.proposal);
            }

            const applyById = new Map<string, PrivateExtensionEntry>();
            for (const proposal of selected) {
                applyById.set(normalizePrivateExtensionId(proposal.candidate.id), proposal.merged.entry);
            }

            const updated: PrivateExtensionEntry[] = [];
            const seen = new Set<string>();
            for (const entry of existing) {
                const id = normalizePrivateExtensionId(entry.id);
                if (seen.has(id)) { continue; }
                seen.add(id);
                updated.push(applyById.get(id) ?? entry);
            }
            for (const [id, entry] of applyById.entries()) {
                if (!seen.has(id)) { seen.add(id); updated.push(entry); }
            }

            await cfg.update('privateExtensions', updated, vscode.ConfigurationTarget.Global);

            const addedCount = selected.filter(p => !p.existingEntry).length;
            const updatedCount = selected.filter(p => !!p.existingEntry).length;
            ctx.outputChannel.appendLine(`[Private Extensions] Auto-detect applied: +${addedCount}, ~${updatedCount}.`);
            void notify.info(`Auto-detect applied (+${addedCount}, ~${updatedCount}).`);
            ctx.treeProvider.refresh();
        })
    );
}
