import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlow, Background, Controls, applyNodeChanges, Node, NodeChange, Position } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './style.css';
import { Change, ProviderId, providers, providerLabels, ClientMessage, HostMessage, Run, Workflow, WorkflowNode } from '../src/contracts';

declare function acquireVsCodeApi(): { postMessage(message: ClientMessage): void };
const vscode = acquireVsCodeApi();
type DocumentState = Extract<HostMessage, { type: 'document' }>;

function NodeForm({ node, disabled, change, agents }: { node: WorkflowNode; disabled: boolean; agents: { id: string; name: string; provider?: string }[]; change: (change: Change) => void }) {
  const [label, setLabel] = useState(node.label);
  const [agentId, setAgentId] = useState(node.config.agentId === null ? '__none__' : String(node.config.agentId ?? ''));
  const [provider, setProvider] = useState(String(node.config.provider ?? 'mock'));
  const [model, setModel] = useState(String(node.config.model ?? ''));
  const [optional,setOptional] = useState(node.config.optional === true);
  const [prompt, setPrompt] = useState(String(node.config.prompt ?? ''));
  return <form onSubmit={event => { event.preventDefault(); change({ kind: 'configure', nodeId: node.id, label, prompt, ...(node.kind === 'agent' ? { agentId: agentId === '__none__' ? null : agentId, provider: provider as ProviderId, model, optional } : {}) }); }}>
    <p className="eyebrow">{node.kind === 'agent' ? 'AGENT' : 'HUMAN APPROVAL'}</p>
    <fieldset disabled={disabled}>
      <label htmlFor="step-name">Step name</label><input id="step-name" value={label} maxLength={200} required onChange={event => setLabel(event.target.value)} />
      {node.kind === 'agent' ? <><label>Agent configuration<select value={agentId} onChange={event => setAgentId(event.target.value)}><option value="">Use task default</option><option value="__none__">No preset</option>{agentId && agentId !== '__none__' && !agents.some(agent => agent.id === agentId) && <option value={agentId}>Unavailable agent</option>}{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name} ({agent.provider ?? 'step provider'})</option>)}</select></label><p className="muted">The profile supplies instructions; optional provider/model preferences override these step defaults. Missing preferences inherit them. The prompt remains this step's request. Runs preserve a snapshot.</p><label>Step provider<select value={provider} onChange={event => setProvider(event.target.value)}>{providers.map(item => <option key={item} value={item}>{providerLabels[item]}</option>)}</select></label><p className="muted">Gemini/Copilot support bound reads and approved edits; shell execution is unavailable.</p><label>Model (optional)<input value={model} maxLength={200} onChange={event => setModel(event.target.value)} placeholder="Native default" /></label><label><input type="checkbox" checked={optional} disabled={!node.config.readOnly || Boolean(node.config.requireVerification)} onChange={event=>setOptional(event.target.checked)}/>Optional informational phase</label><p className="muted">Only read-only phases without required verification or an agent approval gate can be skipped. Required AI OS checks remain required. Configure readOnly in workflow JSON before marking an informational phase optional.</p><label htmlFor="step-prompt">Prompt</label><textarea id="step-prompt" value={prompt} maxLength={16000} required rows={7} onChange={event => setPrompt(event.target.value)} /></> : <p>This step pauses until you explicitly approve it in VS Code.</p>}
      <button type="submit">Apply changes</button>
      <button className="secondary danger" type="button" onClick={() => change({ kind: 'remove', nodeId: node.id })}>Remove step</button>
    </fieldset>
  </form>;
}

function WorkflowName({ workflow, disabled, change }: { workflow: Workflow; disabled: boolean; change: (change: Change) => void }) {
  const [name, setName] = useState(workflow.name);
  return <form className="name-form" onSubmit={event => { event.preventDefault(); change({ kind: 'rename', name }); }}>
    <input aria-label="Workflow name" required maxLength={200} disabled={disabled} value={name} onChange={event => setName(event.target.value)} />
    {name !== workflow.name && <button disabled={disabled}>Rename</button>}
  </form>;
}

function App() {
  const [document, setDocument] = useState<DocumentState>();
  const [run, setRun] = useState<Run>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [nodes, setNodes] = useState<Node[]>([]);
  useEffect(() => {
    const listener = (event: MessageEvent<HostMessage>) => {
      const message = event.data;
      if (message.type === 'document') { setDocument(message); setPending(false); }
      if (message.type === 'run') setRun(message.run);
      if (message.type === 'error') { setError(message.message); setPending(false); }
    };
    window.addEventListener('message', listener); vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  }, []);
  const workflow = document?.workflow;
  useEffect(() => {
    if (!workflow) return;
    setNodes(workflow.nodes.map(node => ({ id: node.id, position: node.position, selected: node.id === selected,
      data: { label: <><span className="node-kind">{node.kind === 'agent' ? 'Mock agent' : 'Approval'}</span><strong>{node.label}</strong><span className="node-status">{run?.workflow.id === workflow.id ? run.steps[node.id]?.status ?? 'Not in this run' : 'Ready'}</span></> },
      className: `workflow-node ${node.kind}`, sourcePosition: Position.Right, targetPosition: Position.Left,
    })));
  }, [workflow, selected, run]);
  const change = (value: Change) => {
    if (!document || pending || !document.trusted) return;
    setError(''); setPending(true); vscode.postMessage({ type: 'update', revision: document.revision, change: value });
  };
  const onNodesChange = (changes: NodeChange[]) => {
    setNodes(current => applyNodeChanges(changes, current));
    for (const value of changes) if (value.type === 'position' && value.position && !value.dragging) change({ kind: 'move', nodeId: value.id, x: value.position.x, y: value.position.y });
  };
  const active = run && ['queued', 'running', 'waitingApproval'].includes(run.status);
  const disabled = pending || !document?.trusted;
  const node = workflow?.nodes.find(node => node.id === selected);
  return <main>
    <header>
      <div><p className="eyebrow">AI OS / WORKFLOWS</p><h1>Build a workflow</h1><p className="muted">Connect your work, one reviewed step at a time.</p></div>
      <span className="badge">Local mock · No API usage</span>
    </header>
    {!document ? <p role="status">Loading workflow…</p> : <>
      {!document.trusted && <div role="status" className="notice">Restricted mode: trust this workspace to edit or run workflows.</div>}
      {(document.error || error) && <div role="alert" className="error">{document.error || error}<button className="secondary" onClick={() => vscode.postMessage({ type: 'openText' })}>Open as text</button></div>}
      {workflow && <>
        <section className="toolbar" aria-label="Workflow actions">
          <WorkflowName key={`${workflow.id}:${workflow.name}`} workflow={workflow} disabled={disabled} change={change} />
          <button className="secondary" disabled={disabled} onClick={() => change({ kind: 'append', nodeKind: 'agent' })}>+ Agent</button>
          <button className="secondary" disabled={disabled} onClick={() => change({ kind: 'append', nodeKind: 'approval' })}>+ Approval</button>
          <button disabled={disabled || Boolean(active)} onClick={() => { setError(''); vscode.postMessage({ type: 'run', revision: document.revision }); }}>Run workflow</button>
        </section>
        <div className="editor-grid">
          <section className="canvas" aria-label="Workflow canvas">
            <ReactFlow key={`${workflow.id}:${workflow.nodes.length}`} nodes={nodes} edges={workflow.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, animated: run?.status === 'running' }))}
              onNodesChange={onNodesChange} onNodeClick={(_, node) => setSelected(node.id)} onPaneClick={() => setSelected(undefined)}
              nodesDraggable={!disabled} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null} multiSelectionKeyCode={null} selectionOnDrag={false}
              fitView minZoom={0.25} maxZoom={1.5} aria-label="Linear workflow diagram">
              <Background gap={24} size={1} /><Controls showInteractive={false} />
            </ReactFlow>
            <span className="canvas-hint">Drag to arrange · Select a step to edit · Ctrl/Cmd+S to save</span>
          </section>
          <aside aria-label="Step settings">
            {node ? <NodeForm key={`${node.id}:${document.revision}`} node={node} disabled={disabled} change={change} agents={document.agents ?? []} /> : <><p className="eyebrow">STEP SETTINGS</p><h2>A simple place to start</h2><p>Select a step to change its name and prompt. New steps are connected in order.</p><p className="muted">Choose Claude Code, Codex, or a mock agent. Saved presets supply the provider and instructions.</p></>}
          </aside>
        </div>
        <section className="run-panel" aria-label="Run details">
          <div className="run-heading"><h2>Run activity</h2><span role="status" className="badge">{run?.status ?? 'No runs yet'}</span>
            {run?.status === 'waitingApproval' && !Object.values(run.steps).some(step => step.toolApproval) && <button disabled={!document.trusted} onClick={() => vscode.postMessage({ type: 'approve', runId: run.id })}>{Object.values(run.steps).some(step => step.memoryApproval) ? 'Continue after memory approval' : 'Review & approve'}</button>}
            {active && <button className="secondary" disabled={!document.trusted} onClick={() => vscode.postMessage({ type: 'cancel', runId: run!.id })}>Cancel run</button>}
          </div>
          {!run ? <p className="muted">Run this workflow to see each step progress. The mock never changes project files.</p> : <>
            <p className="muted">{new Date(run.createdAt).toLocaleString()} · Saved workflow snapshot{run.story ? ` ? Story: ${run.story.title}` : ''}{run.taskUri ? ' · Task linked' : ''}</p>
            <ol>{run.workflow.nodes.map(node => <li key={node.id}><div><strong>{node.label}</strong><span className="step-status">{run.steps[node.id].status}</span></div>{run.steps[node.id].activity && <p>{run.steps[node.id].activity}</p>}{run.steps[node.id].providerSessionId && <p className="muted">Session: {run.steps[node.id].providerSessionId}</p>}{run.steps[node.id].output && <pre>{run.steps[node.id].output}</pre>}</li>)}</ol>
            {run.error && <p role="alert">{run.error}</p>}
            {['interrupted', 'waitingApproval'].includes(run.status) && <p className="muted">{run.story ? 'Story runs require a fresh launch against the current epic.' : 'Mock runs can resume from Run History. For native runs, review existing edits before starting a new run; saved session IDs identify the native conversation.'}</p>}
          </>}
        </section>
      </>}
    </>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
