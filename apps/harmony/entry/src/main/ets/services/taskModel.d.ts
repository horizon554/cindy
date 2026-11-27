export interface MessageBlock { kind: string; text: string; rows?: string[][] }
export interface MessageSpan { text: string; url?: string; bold?: boolean; code?: boolean }
export function messageBlocks(text: string): MessageBlock[];
export function messageSpans(text: string): MessageSpan[];
