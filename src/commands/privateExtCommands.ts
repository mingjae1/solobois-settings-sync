import * as vscode from 'vscode';
import type { AppContext } from '../context';
import { registerRemovePrivateExtCommand } from './privateExt/removePrivateExt';
import { registerRegisterPrivateExtCommand } from './privateExt/registerPrivateExt';
import { registerUploadVsixToGistCommand } from './privateExt/uploadVsixToGist';
import { registerAutoDetectPrivateExtCommand } from './privateExt/autoDetectPrivateExt';

export function registerPrivateExtCommands(context: vscode.ExtensionContext, ctx: AppContext): void {
    registerRemovePrivateExtCommand(context, ctx);
    registerRegisterPrivateExtCommand(context, ctx);
    registerUploadVsixToGistCommand(context, ctx);
    registerAutoDetectPrivateExtCommand(context, ctx);
}
