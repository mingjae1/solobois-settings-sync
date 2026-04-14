import * as vscode from 'vscode';
import { sensitiveDataGuard } from '../sensitiveDataGuard';

type GistFileMap = Record<string, { content: string }>;

export type UploadPrivacyReviewResult =
    | { cancelled: true }
    | { cancelled: false; files: GistFileMap };

type UploadPrivacyReviewOptions = {
    isPublicGist: boolean;
    silent: boolean;
    outputChannel: vscode.OutputChannel;
};

type PrivacyFinding = {
    filename: string;
    original: string;
    sanitized: string;
    redactedCount: number;
};

function findPrivacyFindings(files: GistFileMap): PrivacyFinding[] {
    const findings: PrivacyFinding[] = [];

    for (const [filename, file] of Object.entries(files)) {
        const original = file.content;
        const redacted = sensitiveDataGuard.redactJsonString(original, 'public');
        const sanitized = redacted.result;
        if (sanitized === original) {
            continue;
        }

        findings.push({
            filename,
            original,
            sanitized,
            redactedCount: redacted.report.totalRemoved
        });
    }

    return findings;
}

async function askUserActionForFinding(
    finding: PrivacyFinding,
    isPublicGist: boolean
): Promise<'mask' | 'exclude' | 'keep' | 'cancel'> {
    const riskText = finding.redactedCount > 0
        ? `Detected ${finding.redactedCount} sensitive value(s) in ${finding.filename}.`
        : `Detected sensitive patterns in ${finding.filename}.`;
    const gistText = isPublicGist ? 'This upload is Public Gist.' : 'This upload is Private Gist.';

    const selection = await vscode.window.showWarningMessage(
        `${riskText} ${gistText}`,
        { modal: true },
        'Mask And Continue',
        'Exclude This File',
        'Keep Original',
        'Cancel Upload'
    );

    if (selection === 'Mask And Continue') {
        return 'mask';
    }
    if (selection === 'Exclude This File') {
        return 'exclude';
    }
    if (selection === 'Keep Original') {
        return 'keep';
    }
    return 'cancel';
}

async function confirmKeepOriginalOnPublic(filename: string): Promise<boolean> {
    const selection = await vscode.window.showWarningMessage(
        `Keep original content for ${filename} in Public Gist? This may expose secrets.`,
        { modal: true },
        'Keep Original',
        'Back'
    );
    return selection === 'Keep Original';
}

export async function reviewFilesForSensitiveUpload(
    files: GistFileMap,
    options: UploadPrivacyReviewOptions
): Promise<UploadPrivacyReviewResult> {
    const reviewed: GistFileMap = {};
    for (const [filename, file] of Object.entries(files)) {
        reviewed[filename] = { content: file.content };
    }

    const findings = findPrivacyFindings(reviewed);
    if (findings.length === 0) {
        return { cancelled: false, files: reviewed };
    }

    if (options.silent) {
        for (const finding of findings) {
            reviewed[finding.filename] = { content: finding.sanitized };
            options.outputChannel.appendLine(
                `[Privacy] Auto-masked sensitive content in ${finding.filename} (silent mode).`
            );
        }
        return { cancelled: false, files: reviewed };
    }

    for (const finding of findings) {
        while (true) {
            const action = await askUserActionForFinding(finding, options.isPublicGist);
            if (action === 'cancel') {
                options.outputChannel.appendLine(`[Privacy] Upload cancelled by user at ${finding.filename}.`);
                return { cancelled: true };
            }

            if (action === 'exclude') {
                delete reviewed[finding.filename];
                options.outputChannel.appendLine(`[Privacy] Excluded ${finding.filename} from upload.`);
                break;
            }

            if (action === 'mask') {
                reviewed[finding.filename] = { content: finding.sanitized };
                options.outputChannel.appendLine(`[Privacy] Masked sensitive content in ${finding.filename}.`);
                break;
            }

            if (action === 'keep') {
                if (options.isPublicGist) {
                    const confirmed = await confirmKeepOriginalOnPublic(finding.filename);
                    if (!confirmed) {
                        continue;
                    }
                }
                options.outputChannel.appendLine(`[Privacy] Kept original content for ${finding.filename}.`);
                break;
            }
        }
    }

    if (Object.keys(reviewed).length === 0) {
        options.outputChannel.appendLine('[Privacy] All files were excluded by policy/user choice.');
        return { cancelled: true };
    }

    return { cancelled: false, files: reviewed };
}

