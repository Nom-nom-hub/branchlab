/** Session store (PRD §7, FR-07): experiments, test runs, and the
 *  operation journal in one JSON document under extension-managed local
 *  storage. Writes are atomic (temp file + rename) so an interrupted
 *  shutdown never leaves a torn record. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExperimentRecord, JournalEntry, TestRunRecord } from './model.js';

export interface StoreData {
  experiments: ExperimentRecord[];
  testRuns: TestRunRecord[];
  journal: JournalEntry[];
}

const EMPTY: StoreData = { experiments: [], testRuns: [], journal: [] };

export class Store {
  private file: string;
  private data: StoreData = structuredClone(EMPTY);
  /** True when the on-disk file existed but could not be parsed — the
   *  caller surfaces this rather than silently starting empty. */
  corrupt = false;

  constructor(baseDir: string) {
    this.file = path.join(baseDir, 'branchlab-store.json');
  }

  load(): StoreData {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoreData>;
      this.data = {
        experiments: Array.isArray(parsed.experiments) ? parsed.experiments : [],
        testRuns: Array.isArray(parsed.testRuns) ? parsed.testRuns : [],
        journal: Array.isArray(parsed.journal) ? parsed.journal : [],
      };
    } catch {
      if (fs.existsSync(this.file)) {
        this.corrupt = true;
      }
      this.data = structuredClone(EMPTY);
    }
    return this.data;
  }

  get(): StoreData {
    return this.data;
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  upsertExperiment(exp: ExperimentRecord): void {
    const idx = this.data.experiments.findIndex((e) => e.id === exp.id);
    if (idx >= 0) {
      this.data.experiments[idx] = exp;
    } else {
      this.data.experiments.push(exp);
    }
    this.save();
  }

  removeExperiment(id: string): void {
    this.data.experiments = this.data.experiments.filter((e) => e.id !== id);
    this.data.testRuns = this.data.testRuns.filter((r) =>
      this.data.experiments.some((e) => e.variants.some((v) => v.id === r.variantId)),
    );
    this.save();
  }

  addTestRun(run: TestRunRecord): void {
    this.data.testRuns.push(run);
    // Bound history: keep the newest 200 runs.
    if (this.data.testRuns.length > 200) {
      this.data.testRuns = this.data.testRuns.slice(-200);
    }
    this.save();
  }

  startJournal(entry: JournalEntry): void {
    this.data.journal.push(entry);
    this.save();
  }

  updateJournal(opId: string, mutate: (entry: JournalEntry) => void): void {
    const entry = this.data.journal.find((j) => j.opId === opId);
    if (entry) {
      mutate(entry);
      this.save();
    }
  }

  unfinishedJournal(): JournalEntry[] {
    return this.data.journal.filter((j) => !j.finished);
  }
}
