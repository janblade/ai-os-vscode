const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

export interface QuestionPresentation { options?: {label: string; description?: string}[]; recommendation?: string; cancelLabel?: string }
export function confirmationHtml(message: string, detail: string, choices: string[], nonce: string, question = false, presentation: QuestionPresentation = {}): string {
  const cancelLabel = question ? presentation.cancelLabel ?? 'Cancel' : 'Cancel';
  const form = question ? `<details class="reply" ${choices.length ? '' : 'open'}><summary>${choices.length ? 'Give a different instruction' : 'Write your reply'}</summary><label for="answer">Your reply</label><textarea id="answer" rows="5" maxlength="16000"></textarea><button type="button" id="send">Send reply</button></details>` : '';
  const hint = question && cancelLabel === 'Stop run' ? 'Your choice guides the agent; it does not approve tool permissions or plan changes. Closing this tab or pressing Escape stops this run.' : 'Applies only to this request. Closing this tab or pressing Escape cancels it.';
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">
body{font-family:var(--vscode-font-family, system-ui, sans-serif);color:var(--vscode-foreground, #e4e4e7);background:var(--vscode-editor-background, #18181b);padding:24px;margin:0}main{max-width:780px;margin:24px auto}article{border:1px solid var(--vscode-panel-border, #3f3f46);border-radius:12px;padding:24px;background:var(--vscode-sideBar-background, #202024)}.label{color:var(--vscode-descriptionForeground, #a1a1aa);font-size:12px}h1{font-size:20px;line-height:1.4;overflow-wrap:anywhere}h2{font-size:14px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit;line-height:1.6;max-height:260px;overflow:auto}footer{display:flex;gap:10px;flex-wrap:wrap;margin-top:24px}button{max-width:100%;overflow-wrap:anywhere;text-align:left;font:inherit;padding:8px 16px;border:1px solid transparent;border-radius:5px;cursor:pointer;background:var(--vscode-button-secondaryBackground, #3f3f46);color:var(--vscode-button-secondaryForeground, #fafafa)}button.primary{background:var(--vscode-button-background, #2563eb);color:var(--vscode-button-foreground, #ffffff)}button:focus-visible,summary:focus-visible,textarea:focus-visible{outline:2px solid var(--vscode-focusBorder, #60a5fa);outline-offset:3px}button:hover{filter:brightness(1.12)}.hint,small{color:var(--vscode-descriptionForeground, #a1a1aa);font-size:12px;margin-top:18px}button small{display:block;color:inherit;margin:6px 0 0;line-height:1.5}.recommendation{border-left:3px solid var(--vscode-focusBorder,#60a5fa);padding:12px;line-height:1.6}.reply{margin:18px 0}summary{cursor:pointer}.reply label{display:block;margin:14px 0 8px}textarea{display:block;box-sizing:border-box;width:100%;margin:8px 0;font:inherit;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:10px}
</style></head><body><main><article aria-labelledby="title"><div class="label">AI OS &middot; ${question ? 'Decision needed' : 'Approval required'}</div><h1 id="title">${escape(message)}</h1>${question ? '<h2>Why the agent paused</h2>' : ''}<pre>${escape(detail)}</pre>${question && presentation.recommendation ? `<section class="recommendation"><strong>Suggested next step</strong><p>${escape(presentation.recommendation)}</p></section>` : ''}<footer>${choices.map((choice, index) => `<button type="button" data-choice="${index}" class="${index === 0 ? 'primary' : ''}">${escape(choice)}${question && presentation.options?.[index]?.description ? `<small>${escape(presentation.options[index].description!)}</small>` : ''}</button>`).join('')}<button type="button" id="cancel">${escape(cancelLabel)}</button></footer>${form}<p class="hint">${hint}</p><p id="status" role="status"></p></article></main><script nonce="${nonce}">
const api=acquireVsCodeApi();let sent=false;function submit(payload){if(sent)return;sent=true;document.querySelectorAll('button,textarea').forEach(element=>element.disabled=true);document.getElementById('status').textContent='Submitting response...';api.postMessage(payload);}
document.querySelectorAll('[data-choice]').forEach(button=>button.addEventListener('click',()=>submit({type:'${question ? 'question' : 'confirmation'}',choice:Number(button.dataset.choice)})));
${question ? "document.getElementById('send').addEventListener('click',()=>{const answer=document.getElementById('answer');if(!answer.value.trim()){answer.focus();return;}submit({type:'question',answer:answer.value});});" : ''}
const cancel=()=>submit(${question ? "{type:'question',answer:null}" : "{type:'confirmation',choice:null}"});document.getElementById('cancel').addEventListener('click',cancel);document.addEventListener('keydown',event=>{if(event.key==='Escape')cancel();});document.getElementById('cancel').focus();
</script></body></html>`;
}

export function confirmationChoice(raw: unknown, choices: string[]): string | null | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const message = raw as Record<string, unknown>;
  if (message.type !== 'confirmation') return undefined;
  if (message.choice === null) return null;
  return typeof message.choice === 'number' && Number.isInteger(message.choice) && message.choice >= 0 && message.choice < choices.length ? choices[message.choice] : undefined;
}

export function questionAnswer(raw: unknown, choices: string[] = []): string | null | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const message = raw as Record<string, unknown>;
  if (message.type !== 'question') return undefined;
  if (Object.hasOwn(message, 'choice')) return typeof message.choice === 'number' && Number.isInteger(message.choice) && message.choice >= 0 && message.choice < choices.length ? choices[message.choice] : undefined;
  if (message.answer === null) return null;
  return typeof message.answer === 'string' && message.answer.trim() && message.answer.length <= 16000 ? message.answer.trim() : undefined;
}
