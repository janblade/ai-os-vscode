import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { confirmationChoice, confirmationHtml, questionAnswer, QuestionPresentation } from '../core/confirmation';

export const confirmation = {
  ask(message: string, detail: string, signal?: AbortSignal, presentation: QuestionPresentation = {}): Promise<string | null> {
    if (typeof message !== 'string' || !message.trim() || message.length > 16000 || typeof detail !== 'string' || detail.length > 40000
      || presentation.recommendation !== undefined && (typeof presentation.recommendation !== 'string' || presentation.recommendation.length > 4000)
      || presentation.cancelLabel !== undefined && (typeof presentation.cancelLabel !== 'string' || !presentation.cancelLabel.trim() || presentation.cancelLabel.length > 100)
      || presentation.options !== undefined && (!Array.isArray(presentation.options) || presentation.options.length > 12 || presentation.options.some(option => !option || typeof option.label !== 'string' || !option.label.trim() || option.label.length > 200 || option.description != null && (typeof option.description !== 'string' || option.description.length > 2000)))) throw new Error('Invalid agent question.');
    return openRequest(message, detail, presentation.options?.map(option => option.label) ?? [], true, signal, presentation);
  },
  show(message: string, options: { detail?: string }, ...choices: string[]): Promise<string | undefined> {
    return openRequest(message, options.detail ?? '', choices, false).then(value => value ?? undefined);
  },
};

function openRequest(message: string, detail: string, choices: string[], question: boolean, signal?: AbortSignal, presentation: QuestionPresentation = {}): Promise<string | null> {
    if (signal?.aborted) return Promise.resolve(null);
    const panel = vscode.window.createWebviewPanel('aiOs.confirmation', question ? 'AI OS - Agent question' : 'AI OS - Approval required', vscode.ViewColumn.Beside, { enableScripts: true, localResourceRoots: [] });
    return new Promise(resolve => {
      let settled = false;
      const finish = (choice: string | null = null) => {
        if (settled) return;
        settled = true; signal?.removeEventListener('abort', cancel); listener.dispose(); closed.dispose(); panel.dispose(); resolve(choice);
      };
      const cancel = () => finish();
      const listener = panel.webview.onDidReceiveMessage(raw => {
        const choice = question ? questionAnswer(raw, choices) : confirmationChoice(raw, choices);
        if (choice !== undefined) finish(choice);
      });
      const closed = panel.onDidDispose(() => finish());
      signal?.addEventListener('abort', cancel, { once: true });
      panel.webview.html = confirmationHtml(message, detail, choices, randomUUID().replaceAll('-', ''), question, presentation);
    });
}
