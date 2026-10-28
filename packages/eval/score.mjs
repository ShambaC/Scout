// Scores a Scout project DB against a gold set. Usage: node packages/eval/score.mjs <project.sqlite> <gold.json>
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const STOP = new Set('a an and are as at be by for from in is it of on or the to with'.split(' '));
const THRESHOLD = 0.2;

export function tokenize(text) {
  return new Set(
    String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
      .filter((w) => w && !STOP.has(w))
      // Crude stem; the length guard keeps short words like "ss" or "need" intact.
      .map((w) => { const s = w.replace(/(ing|ed|s)$/, ''); return s.length >= 3 ? s : w; }),
  );
}

export function jaccard(a, b) {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

// A known gap is recalled when its best-matching candidate scores >= threshold.
export function matchGaps(known, gaps, threshold = THRESHOLD) {
  const cands = gaps.map((g) => ({ id: g.id, tokens: tokenize(`${g.title} ${g.statement}`) }));
  const matched = [];
  for (const k of known) {
    const kt = tokenize(k.text);
    let best = { gap_id: null, score: 0 };
    for (const c of cands) {
      const score = jaccard(kt, c.tokens);
      if (score > best.score) best = { gap_id: c.id, score };
    }
    if (best.score >= threshold) {
      matched.push({ known_id: k.id, gap_id: best.gap_id, score: Math.round(best.score * 1000) / 1000 });
    }
  }
  return matched;
}

function isAlreadyDone(g) {
  let verdict;
  try { verdict = JSON.parse(g.critique_json ?? 'null')?.verdict; } catch { verdict = undefined; }
  if (verdict === 'already_done') return true;
  return g.status === 'rejected' && /already/i.test(`${g.reject_reason ?? ''} ${g.critique_json ?? ''}`);
}

export function score(db, gold) {
  const gaps = db.prepare('SELECT id, title, statement, status, reject_reason, critique_json FROM gap_candidates').all();
  const matched = matchGaps(gold.known_gaps, gaps);
  const alreadyDone = gaps.filter(isAlreadyDone).length;

  let citation_validity_rate = null;
  const prop = db.prepare('SELECT id FROM proposals ORDER BY created_at DESC, id DESC LIMIT 1').get();
  if (prop) {
    const { total, ok } = db.prepare(
      'SELECT COUNT(*) AS total, COALESCE(SUM(verified), 0) AS ok FROM proposal_citations WHERE proposal_id = ?',
    ).get(prop.id);
    if (total) citation_validity_rate = ok / total;
  }

  return {
    recall_known_gaps: gold.known_gaps.length ? matched.length / gold.known_gaps.length : null,
    matched,
    already_done_share: gaps.length ? alreadyDone / gaps.length : null,
    citation_validity_rate,
    n_gaps: gaps.length,
  };
}

export function run(dbPath, goldPath) {
  // Read-only so scoring never writes to the user's project file.
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const result = score(db, JSON.parse(readFileSync(goldPath, 'utf8')));
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dbPath, goldPath] = process.argv.slice(2);
  if (!goldPath) {
    console.error('usage: node packages/eval/score.mjs <project.sqlite> <gold.json>');
    process.exit(2);
  }
  run(dbPath, goldPath);
}
