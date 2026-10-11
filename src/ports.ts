/** Loopback port allocation (PRD FR-03). Candidates are probed with a real
 *  bind attempt; a port that loses a bind race is skipped — BranchLab
 *  never kills a process to take a port (AC-04). */
import * as net from 'node:net';

export function probePort(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

/** First free port in [start, end], excluding `taken`. Null when the whole
 *  range is busy (bounded — the caller reports it, never hunts forever). */
export async function pickPort(
  start: number,
  end: number,
  taken: ReadonlySet<number> = new Set(),
  probe: (port: number) => Promise<boolean> = probePort,
): Promise<number | null> {
  for (let port = start; port <= end; port++) {
    if (taken.has(port)) {
      continue;
    }
    if (await probe(port)) {
      return port;
    }
  }
  return null;
}
