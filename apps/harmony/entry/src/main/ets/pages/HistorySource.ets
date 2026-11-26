import { Row } from '../services/workspace';

export class HistorySource implements IDataSource {
  private rows: Row[] = [];
  private listeners: Set<DataChangeListener> = new Set();

  totalCount(): number { return this.rows.length; }
  getData(index: number): Row { return this.rows[index]; }
  registerDataChangeListener(listener: DataChangeListener): void { this.listeners.add(listener); }
  unregisterDataChangeListener(listener: DataChangeListener): void { this.listeners.delete(listener); }

  replace(rows: Row[]): void {
    const previous = this.rows;
    if (previous === rows) return;
    this.rows = rows;
    const added = rows.length - previous.length;
    const offset = added > 0 && previous.length && previous[0].id === rows[added].id ? added : 0;
    const retained = added >= 0 && previous.every((row: Row, i: number) =>
      row.id === rows[i + offset].id && row.title === rows[i + offset].title && row.role === rows[i + offset].role);
    if (retained && added === 0) return;
    const operations: DataOperation[] = retained && previous.length > 0 ?
      [{ type: DataOperationType.ADD, index: offset > 0 ? 0 : previous.length, count: added }] :
      [{ type: DataOperationType.RELOAD }];
    this.listeners.forEach((listener: DataChangeListener) => listener.onDatasetChange(operations));
  }
}
