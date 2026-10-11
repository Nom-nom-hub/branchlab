/** Minimal vscode stub for BranchLab host tests. Only what activate()
 *  and the command registrations touch. */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const __commands = new Map<string, (...args: unknown[]) => unknown>();
export const __configStore = new Map<string, unknown>();
export let __workspaceFolder: string | null = null;
export function __setWorkspaceFolder(dir: string | null): void {
  __workspaceFolder = dir;
}

class FakeUri {
  constructor(
    public scheme: string,
    public fsPath: string,
    public query = '',
  ) {}
  get path(): string {
    return this.fsPath;
  }
  toString(): string {
    return `${this.scheme}://${this.fsPath}`;
  }
  static file(p: string): FakeUri {
    return new FakeUri('file', p);
  }
  static parse(s: string): FakeUri {
    return new FakeUri('https', s);
  }
  static from(parts: { scheme: string; path: string; query?: string }): FakeUri {
    return new FakeUri(parts.scheme, parts.path, parts.query ?? '');
  }
  static joinPath(base: FakeUri, ...parts: string[]): FakeUri {
    return new FakeUri(base.scheme, path.join(base.fsPath, ...parts));
  }
}

export const Uri = FakeUri;

export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (fn: (e: T) => void) => {
    this.listeners.push(fn);
    return { dispose: () => undefined };
  };
  fire(e: T): void {
    for (const fn of this.listeners) {
      fn(e);
    }
  }
}

export class TreeItem {
  description?: string;
  tooltip?: string;
  contextValue?: string;
  command?: unknown;
  constructor(
    public label: string,
    public collapsibleState?: number,
  ) {}
}
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
export const ViewColumn = { One: 1, Two: 2 };
export const ProgressLocation = { Notification: 15 };

export const window = {
  registerTreeDataProvider: () => ({ dispose: () => undefined }),
  createOutputChannel: (name: string) => ({
    name,
    appendLine: () => undefined,
    append: () => undefined,
    clear: () => undefined,
    show: () => undefined,
    dispose: () => undefined,
  }),
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showQuickPick: async () => undefined,
  showInputBox: async () => undefined,
  showTextDocument: async () => ({}),
  createWebviewPanel: () => {
    throw new Error('webview not available in tests');
  },
  withProgress: async (_opts: unknown, task: () => Promise<unknown>) => task(),
};

export const workspace = {
  get workspaceFolders() {
    return __workspaceFolder
      ? [{ uri: FakeUri.file(__workspaceFolder), name: path.basename(__workspaceFolder), index: 0 }]
      : undefined;
  },
  isTrusted: true,
  textDocuments: [] as unknown[],
  getConfiguration(section: string) {
    return {
      get<T>(key: string, def?: T): T | undefined {
        const full = `${section}.${key}`;
        return __configStore.has(full) ? (__configStore.get(full) as T) : def;
      },
      async update(key: string, value: unknown): Promise<void> {
        const full = `${section}.${key}`;
        if (value === undefined) {
          __configStore.delete(full);
        } else {
          __configStore.set(full, value);
        }
      },
    };
  },
  onDidChangeWorkspaceFolders: () => ({ dispose: () => undefined }),
  onDidChangeConfiguration: () => ({ dispose: () => undefined }),
  registerTextDocumentContentProvider: () => ({ dispose: () => undefined }),
  createFileSystemWatcher: () => ({
    onDidChange: () => undefined,
    onDidCreate: () => undefined,
    onDidDelete: () => undefined,
    dispose: () => undefined,
  }),
  openTextDocument: async (opts: { content?: string }) => ({ getText: () => opts.content ?? '' }),
  fs: { readFile: async (uri: FakeUri) => fs.readFileSync(uri.fsPath) },
};

export class RelativePattern {
  constructor(
    public base: FakeUri,
    public pattern: string,
  ) {}
}

export const commands = {
  registerCommand: (id: string, fn: (...args: unknown[]) => unknown) => {
    __commands.set(id, fn);
    return { dispose: () => __commands.delete(id) };
  },
  executeCommand: async () => undefined,
};

export const env = {
  openExternal: async () => true,
  clipboard: {
    written: '',
    async writeText(text: string): Promise<void> {
      this.written = text;
    },
  },
};
