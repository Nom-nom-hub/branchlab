/** Closed webview message schema (PRD §8, AC-14). The comparison panel
 *  can ask for exactly these actions; anything else is rejected by the
 *  host without side effects. Preview iframes never post here — only the
 *  bundled panel UI does, and the host validates every field anyway. */

export type PanelMessage =
  | { type: 'ready' }
  | { type: 'startServer'; variantId: string }
  | { type: 'stopServer'; variantId: string }
  | { type: 'restartServer'; variantId: string }
  | { type: 'install'; variantId: string }
  | { type: 'openVariant'; variantId: string }
  | { type: 'openInBrowser'; variantId: string }
  | { type: 'showLogs'; variantId: string }
  | { type: 'showDiff'; variantId: string }
  | { type: 'runTests'; variantId: string }
  | { type: 'cancelRun'; variantId: string }
  | { type: 'copyBrief'; variantId: string }
  | { type: 'runAllTests' }
  | { type: 'applyWinner'; variantId: string }
  | { type: 'openFileDiff'; variantId: string; path: string }
  | { type: 'setRoute'; route: string };

const VARIANT_SCOPED = new Set([
  'startServer', 'stopServer', 'restartServer', 'install', 'openVariant',
  'openInBrowser', 'showLogs', 'showDiff', 'runTests', 'applyWinner',
  'cancelRun', 'copyBrief',
]);

function isId(x: unknown): x is string {
  return typeof x === 'string' && /^[a-z0-9]{4,40}$/i.test(x);
}

export function validatePanelMessage(raw: unknown): PanelMessage | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const msg = raw as Record<string, unknown>;
  const type = msg.type;
  if (typeof type !== 'string') {
    return null;
  }
  if (type === 'ready' || type === 'runAllTests') {
    return { type };
  }
  if (type === 'setRoute') {
    const route = msg.route;
    if (typeof route !== 'string' || route.length > 512 || /[\s\\]/.test(route)) {
      return null;
    }
    // Routes are relative app paths; never protocol or host escapes.
    if (/^[a-z][a-z0-9+.-]*:/i.test(route) || route.startsWith('//')) {
      return null;
    }
    return { type, route: route.startsWith('/') ? route : `/${route}` };
  }
  if (type === 'openFileDiff') {
    if (!isId(msg.variantId) || typeof msg.path !== 'string' || msg.path.length > 1024) {
      return null;
    }
    return { type, variantId: msg.variantId, path: msg.path };
  }
  if (VARIANT_SCOPED.has(type) && isId(msg.variantId)) {
    return { type, variantId: msg.variantId } as PanelMessage;
  }
  return null;
}
