export interface KnownGap { id: string; text: string }
export interface GapRow { id: number; title?: string | null; statement?: string | null }
export interface GapMatch { known_id: string; gap_id: number | null; score: number }
export interface ScoreResult {
  recall_known_gaps: number | null;
  matched: GapMatch[];
  already_done_share: number | null;
  citation_validity_rate: number | null;
  n_gaps: number;
}

export function tokenize(text: unknown): Set<string>;
export function jaccard(a: Set<string>, b: Set<string>): number;
export function matchGaps(known: KnownGap[], gaps: GapRow[], threshold?: number): GapMatch[];
export function score(db: { prepare(sql: string): { all(): any[]; get(...args: any[]): any } }, gold: { known_gaps: KnownGap[] }): ScoreResult;
export function run(dbPath: string, goldPath: string): ScoreResult;
