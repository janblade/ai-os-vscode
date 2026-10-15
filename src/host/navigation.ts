import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { Dashboard } from './dashboard';
import { dashboardPages, parseDashboardMessage } from '../dashboard-contracts';

const labels = { task: 'Tasks', epic: 'Epics', agent: 'Agents', memory: 'Memory', workflow: 'Workflows', repository: 'Repositories', run: 'Runs' };
const icons = {
  task: '<path d="m4 6 2 2 4-4M12 6h8M4 14l2 2 4-4M12 14h8M12 20h8"/>',
  epic: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 8h10M7 12h6M7 16h10"/>',
  agent: '<rect x="4" y="7" width="16" height="13" rx="3"/><path d="M12 3v4M8 12h.01M16 12h.01M8 16h8"/>',
  memory: '<path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1v15"/>',
  workflow: '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><path d="M9 6h9v9M6 9v9h9"/>',
  repository: '<path d="M3 7h7l2-3h9v16H3z"/>',
  run: '<path d="m9 5 11 7-11 7zM3 5v14"/>',
};
export class WorkspaceNavigation implements vscode.WebviewViewProvider {
  constructor(private dashboard: Dashboard) {}
  resolveWebviewView(view: vscode.WebviewView): void {
    const nonce = randomUUID().replaceAll('-', '');
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'none';">
<style nonce="${nonce}">body{font:var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-foreground);padding:12px;margin:0}nav{display:grid;gap:6px}button{font:inherit;cursor:pointer;display:flex;align-items:center;gap:10px;text-align:left;padding:10px 12px;border:1px solid transparent;border-radius:5px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button[aria-pressed=true]{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}svg{width:18px;height:18px;flex:none;stroke:currentColor;fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}p{font-size:12px;line-height:1.6;color:var(--vscode-descriptionForeground)}</style></head>
<body><nav aria-label="AI OS pages">${dashboardPages.map(page => `<button data-page="${page}" aria-pressed="${page === this.dashboard.page}"><svg viewBox="0 0 24 24" aria-hidden="true">${icons[page]}</svg><span>${labels[page]}</span></button>`).join('')}</nav><p>Choose a page to browse entries and actions in the workspace dashboard.</p>
<script nonce="${nonce}">const host=acquireVsCodeApi();document.querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>host.postMessage({type:'navigate',page:button.dataset.page})));window.addEventListener('message',event=>{if(event.data.type==='navigate')document.querySelectorAll('button').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.page===event.data.page)));});</script></body></html>`;
    const messages = view.webview.onDidReceiveMessage(async raw => {
      try {
        const message = parseDashboardMessage(raw);
        if (message.type !== 'navigate') throw new Error('Unsupported navigation action.');
        await this.dashboard.show(message.page);
      } catch (error) { void vscode.window.showErrorMessage(`AI OS: ${String(error)}`); }
    });
    const pages = this.dashboard.onDidChangePage(page => { void view.webview.postMessage({ type: 'navigate', page }); });
    view.onDidDispose(() => { messages.dispose(); pages.dispose(); });
  }
}
