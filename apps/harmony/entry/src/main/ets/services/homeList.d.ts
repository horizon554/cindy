import type { Row } from './workspace';
export interface HomeGroup { key: string; kind: string; head: Row; rows: Row[]; total: number }
export function groupHomeRows(rows: Row[], groupProjects: boolean, flat: boolean, searching: boolean, deviceOrder?: string[], collapsed?: string[]): HomeGroup[];
