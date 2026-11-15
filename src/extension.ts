import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Ripple');
  context.subscriptions.push(output);
  output.appendLine('Ripple activated.');
}

export function deactivate(): void {}
