/** Comparison panel (PRD FR-04): variant cards with readiness, preview,
 *  and actions. The webview only renders state and posts messages from
 *  the closed schema in messages.ts — it holds no authority of its own.
 *  Previews are display surfaces: the panel never inspects iframe DOM,
 *  and every card keeps an Open in Browser fallback for apps that refuse
 *  embedding (AC-06). */
import * as vscode from 'vscode';
import { validatePanelMessage, type PanelMessage } from './messages.js';

export interface PanelVariant {
  id: string;
  label: string;
  brief: string;
  setupState: string;
  serverState: string;
  testStatus: string;
  testExit: number | null;
  port: number | null;
  url: string | null;
  changedCount: number;
  lastError: string | null;
  reachableError: boolean;
}

export interface PanelPayload {
  experiment: {
    id: string;
    title: string;
    branch: string;
    baselineShort: string;
    state: string;
    adapter: string;
    packageManager: string;
    testCommand: string | null;
  } | null;
  variants: PanelVariant[];
}

export class ComparisonPanel {
  private panel: vscode.WebviewPanel | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (msg: PanelMessage) => void,
  ) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'branchlab.compare',
      'BranchLab — Compare',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
        // Dev-server previews load from loopback origins inside iframes;
        // the webview itself only runs the bundled panel script below.
        portMapping: [],
      },
    );
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      const msg = validatePanelMessage(raw);
      if (msg) {
        this.onMessage(msg);
      }
    });
    this.panel.onDidDispose(() => {
      this.panel = null;
    });
  }

  post(payload: PanelPayload): void {
    if (this.panel) {
      void this.panel.webview.postMessage({ type: 'state', payload });
    }
  }

  get visible(): boolean {
    return this.panel !== null;
  }

  private html(): string {
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://127.0.0.1:* http://localhost:*; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';" />
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 18px 20px 28px; font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 12px; margin-bottom: 14px; }
  h1 { font-size: 17px; font-weight: 650; margin: 0; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .toolbar { display: flex; gap: 8px; align-items: center; margin-left: auto; flex-wrap: wrap; }
  .toolbar label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); }
  input.route { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 5px 8px; border-radius: 4px; width: 190px; font: inherit; font-size: 12.5px; }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, transparent); padding: 5px 6px; border-radius: 4px; font: inherit; font-size: 12.5px; }
  .grid { display: grid; gap: 14px; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; background: var(--vscode-editorWidget-background, transparent); }
  .card-head { padding: 11px 13px 9px; border-bottom: 1px solid var(--vscode-panel-border); }
  .card-title { display: flex; align-items: center; gap: 8px; }
  .card-title h2 { font-size: 14px; font-weight: 650; margin: 0; }
  .brief { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 3px; line-height: 1.45; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
  .chip { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); }
  .chip.run { color: #4ADE80; border-color: #4ADE8066; }
  .chip.err { color: #F87171; border-color: #F8717166; }
  .chip.warn { color: #FBBF24; border-color: #FBBF2466; }
  .chip.pass { color: #4ADE80; border-color: #4ADE8066; }
  .chip.fail { color: #F87171; border-color: #F8717166; }
  .preview { position: relative; background: #fff; overflow: auto; }
  .preview .frame { margin: 0 auto; transition: max-width .15s ease; }
  .preview iframe { display: block; width: 100%; height: 340px; border: 0; background: #fff; }
  .preview .empty { padding: 26px 16px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 12.5px; line-height: 1.6; background: var(--vscode-editor-background); }
  .url { font-size: 11.5px; color: var(--vscode-textLink-foreground); padding: 6px 13px 0; word-break: break-all; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; padding: 10px 13px 12px; margin-top: auto; }
  button { font: inherit; font-size: 12px; padding: 5px 11px; border-radius: 4px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .45; cursor: default; }
  .apply { margin-left: auto; }
  .error { color: #F87171; font-size: 12px; padding: 0 13px 8px; line-height: 1.5; }
  .note { color: var(--vscode-descriptionForeground); font-size: 11.5px; padding: 0 13px 9px; line-height: 1.5; }
  .empty-state { border: 1px dashed var(--vscode-panel-border); border-radius: 8px; padding: 34px 22px; text-align: center; color: var(--vscode-descriptionForeground); line-height: 1.7; }
  button:focus-visible, input:focus-visible, select:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let payload = null;
  let route = '/';
  let viewport = 'full';

  const VIEWPORTS = { full: '100%', desktop: '1280px', tablet: '768px', phone: '390px' };

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function post(msg) { vscode.postMessage(msg); }

  function serverChip(v) {
    if (v.serverState === 'running') return '<span class="chip run">' + (v.reachableError ? 'Reachable · App error' : 'Running') + ' · :' + v.port + '</span>';
    if (v.serverState === 'starting') return '<span class="chip warn">Starting…</span>';
    if (v.serverState === 'error') return '<span class="chip err">Server error</span>';
    if (v.serverState === 'missing') return '<span class="chip err">Worktree missing</span>';
    return '<span class="chip">Server stopped</span>';
  }
  function setupChip(v) {
    if (v.setupState === 'installing') return '<span class="chip warn">Installing…</span>';
    if (v.setupState === 'installed') return '<span class="chip">Installed</span>';
    if (v.setupState === 'install-error') return '<span class="chip err">Install failed</span>';
    return '<span class="chip warn">Not installed</span>';
  }
  function testChip(v) {
    const map = {
      'not-configured': '<span class="chip">Tests: not configured</span>',
      'never-run': '<span class="chip">Tests: never run</span>',
      'running': '<span class="chip warn">Tests: running…</span>',
      'passed': '<span class="chip pass">Tests: passed</span>',
      'failed': '<span class="chip fail">Tests: failed (' + esc(v.testExit) + ')</span>',
      'stale': '<span class="chip warn">Tests: stale — code changed</span>',
    };
    return map[v.testStatus] || '';
  }

  function card(v) {
    const running = v.serverState === 'running' || v.serverState === 'starting';
    const previewUrl = v.url ? v.url.replace(/\\/$/, '') + route : '';
    let preview;
    if (v.serverState === 'running' && v.url) {
      preview = '<div class="preview"><div class="frame" style="max-width:' + VIEWPORTS[viewport] + '"><iframe title="Preview of ' + esc(v.label) + '" src="' + esc(previewUrl) + '" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"></iframe></div></div>'
        + '<div class="note">Isolated preview — sign-ins, cookies, and storage are per-variant and may differ. If the app refuses to embed, use Open in Browser.</div>';
    } else {
      preview = '<div class="preview"><div class="empty">' + (v.setupState !== 'installed' ? 'Install dependencies, then start the server to see this variant live.' : 'Server is stopped. Start it to see this variant live.') + '</div></div>';
    }
    return '<section class="card" aria-label="Variant ' + esc(v.label) + '">'
      + '<div class="card-head"><div class="card-title"><h2>' + esc(v.label) + '</h2></div>'
      + (v.brief ? '<div class="brief">' + esc(v.brief) + '</div>' : '')
      + '<div class="chips">' + setupChip(v) + serverChip(v) + testChip(v)
      + '<span class="chip">' + v.changedCount + ' changed file' + (v.changedCount === 1 ? '' : 's') + '</span></div></div>'
      + (v.url && running ? '<div class="url">' + esc(previewUrl) + '</div>' : '')
      + preview
      + (v.lastError ? '<div class="error">' + esc(v.lastError) + '</div>' : '')
      + '<div class="actions">'
      + '<button data-act="openVariant" data-id="' + v.id + '">Open</button>'
      + '<button data-act="copyBrief" data-id="' + v.id + '">Copy Brief</button>'
      + (v.setupState !== 'installed' ? '<button class="primary" data-act="install" data-id="' + v.id + '"' + (v.setupState === 'installing' ? ' disabled' : '') + '>Install</button>' : '')
      + (!running
          ? '<button class="primary" data-act="startServer" data-id="' + v.id + '"' + (v.setupState !== 'installed' ? ' disabled title="Install first"' : '') + '>Start</button>'
          : '<button data-act="stopServer" data-id="' + v.id + '">Stop</button><button data-act="restartServer" data-id="' + v.id + '">Restart</button>')
      + '<button data-act="openInBrowser" data-id="' + v.id + '"' + (v.url ? '' : ' disabled') + '>Open in Browser</button>'
      + '<button data-act="showLogs" data-id="' + v.id + '">Logs</button>'
      + '<button data-act="showDiff" data-id="' + v.id + '">Diff</button>'
      + '<button data-act="runTests" data-id="' + v.id + '">Test</button>'
      + '<button class="primary apply" data-act="applyWinner" data-id="' + v.id + '">Apply Winner</button>'
      + '</div></section>';
  }

  function render() {
    const root = document.getElementById('root');
    if (!payload || !payload.experiment) {
      root.innerHTML = '<div class="empty-state">No active experiment for this repository yet.<br/>Run <b>BranchLab: New Experiment</b> from the Command Palette to create variants of the current commit.</div>';
      return;
    }
    const e = payload.experiment;
    const cols = payload.variants.length >= 3 ? 3 : 2;
    root.innerHTML = '<header><h1>' + esc(e.title) + '</h1>'
      + '<span class="meta">baseline ' + esc(e.baselineShort) + ' · ' + esc(e.branch) + ' · ' + esc(e.adapter) + ' · ' + esc(e.packageManager) + (e.testCommand ? ' · tests: ' + esc(e.testCommand) : '') + '</span>'
      + '<div class="toolbar"><label for="route">Route</label><input class="route" id="route" value="' + esc(route) + '" aria-label="Shared preview route" />'
      + '<label for="viewport">Viewport</label><select id="viewport" aria-label="Viewport preset">'
      + Object.keys(VIEWPORTS).map((k) => '<option value="' + k + '"' + (viewport === k ? ' selected' : '') + '>' + k[0].toUpperCase() + k.slice(1) + '</option>').join('')
      + '</select>'
      + '<button id="runAll">Run All Tests</button></div></header>'
      + '<div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(min(100%, ' + (cols === 3 ? '340px' : '420px') + '), 1fr));">'
      + payload.variants.map(card).join('') + '</div>'
      + '<p class="meta" style="margin-top:14px;">Applying a winner copies its reviewed changes into the original workspace as <b>uncommitted</b> changes. Nothing is committed, staged, or deleted.</p>';
    document.getElementById('route').addEventListener('change', (ev) => {
      route = ev.target.value || '/';
      post({ type: 'setRoute', route });
      render();
    });
    document.getElementById('viewport').addEventListener('change', (ev) => { viewport = ev.target.value; render(); });
    document.getElementById('runAll').addEventListener('click', () => post({ type: 'runAllTests' }));
    root.querySelectorAll('button[data-act]').forEach((b) => {
      b.addEventListener('click', () => post({ type: b.getAttribute('data-act'), variantId: b.getAttribute('data-id') }));
    });
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg && msg.type === 'state') {
      payload = msg.payload;
      render();
    }
  });
  post({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
