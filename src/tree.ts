/** Activity Bar tree: experiments and their variants (PRD FR-04). */
import * as vscode from 'vscode';
import type { Store } from './store.js';
import type { ExperimentRecord, VariantRecord } from './model.js';

export class ExperimentTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly store: () => Store) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    const data = this.store().get();
    if (!element) {
      return data.experiments.map((exp) => {
        const item = new vscode.TreeItem(
          exp.title,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.contextValue = 'experiment';
        item.description = exp.state === 'active' ? exp.originalBranch
          : `${exp.state} · ${exp.originalBranch}`;
        item.tooltip = `${exp.title}\nBaseline ${exp.baselineSha.slice(0, 10)} on ${exp.originalBranch}\nAdapter: ${exp.adapter} · ${exp.packageManager}`;
        (item as ExperimentItem).experiment = exp;
        item.command = {
          command: 'branchlab.openPanel',
          title: 'Open Comparison Panel',
          arguments: [exp.id],
        };
        return item;
      });
    }
    const exp = (element as ExperimentItem).experiment;
    if (!exp) {
      return [];
    }
    return exp.variants.map((variant) => {
      const item = new vscode.TreeItem(variant.label, vscode.TreeItemCollapsibleState.None);
      item.contextValue = 'variant';
      item.description = variant.serverState === 'running'
        ? `running · :${variant.port}`
        : variant.serverState;
      item.tooltip = `${variant.label}\n${variant.brief || 'No brief'}\nBranch: ${variant.branch}\nWorktree: ${variant.worktreePath}`;
      (item as VariantItem).experiment = exp;
      (item as VariantItem).variant = variant;
      return item;
    });
  }
}

export interface ExperimentItem extends vscode.TreeItem {
  experiment?: ExperimentRecord;
}

export interface VariantItem extends vscode.TreeItem {
  experiment?: ExperimentRecord;
  variant?: VariantRecord;
}
