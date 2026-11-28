import { Row } from '../services/workspace';

export class HistorySource implements IDataSource {
  private rows: Row[] = [];
  private keys: Map<string, number> = new Map();
  private generation: number = 0;

  key(row: Row): string { return row.id + ':' + this.keys.get(row.id); }
  private listeners: Set<DataChangeListener> = new Set();

  totalCount(): number { return this.rows.length; }
  getData(index: number): Row { return this.rows[index]; }
  registerDataChangeListener(listener: DataChangeListener): void { this.listeners.add(listener); }
  unregisterDataChangeListener(listener: DataChangeListener): void { this.listeners.delete(listener); }

  private sameRow(a: Row, b: Row): boolean {
    if (a === b) return true;
    return a.id === b.id && a.title === b.title && a.role === b.role && a.messageText === b.messageText && a.detail === b.detail && a.actions === b.actions && a.createdAt === b.createdAt &&
      a.editPlacement === b.editPlacement && a.forkable === b.forkable && a.clientId === b.clientId && (a.usage === b.usage || JSON.stringify(a.usage) === JSON.stringify(b.usage)) &&
      (a.voiceCall === b.voiceCall || JSON.stringify(a.voiceCall) === JSON.stringify(b.voiceCall)) &&
      (a.media === b.media || JSON.stringify(a.media) === JSON.stringify(b.media));
  }

  replace(rows: Row[]): void {
    const previous = this.rows;
    if (previous === rows) return;
    // Reuse unchanged list items on a history refresh. Never use the transcript
    // itself as a framework key, even when a saved call is updated in place.
    const prior = new Map<string, Row>();
    previous.forEach((row: Row) => { prior.set(row.id, row); });
    const keys = new Map<string, number>();
    rows.forEach((row: Row) => {
      const old = prior.get(row.id);
      keys.set(row.id, old && this.sameRow(old, row) ? this.keys.get(row.id)! : ++this.generation);
    });
    const previousKeys = this.keys;
    this.keys = keys;
    this.rows = rows;
    const added = rows.length - previous.length;
    const offset = added > 0 && previous.length && previous[0].id === rows[added].id ? added : 0;
    const retained = added >= 0 && previous.every((row: Row, i: number) =>
      previousKeys.get(row.id) === keys.get(rows[i + offset].id));
    if (retained && added === 0) return;
    const operations: DataOperation[] = retained && previous.length > 0 ?
      [{ type: DataOperationType.ADD, index: offset > 0 ? 0 : previous.length, count: added }] :
      [{ type: DataOperationType.RELOAD }];
    this.listeners.forEach((listener: DataChangeListener) => listener.onDatasetChange(operations));
  }
}
