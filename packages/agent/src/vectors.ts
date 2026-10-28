import { db } from "./rust";

const table = (name: string) => {
  if (!/^vec_[a-z_]+$/.test(name)) throw new Error(`Invalid vector table name: ${name}`);
  return name;
};

/** Creates the table; drops and recreates it if the embedding dimension changed. */
export async function ensure(projectId: string, name: string, dim: number): Promise<void> {
  table(name);
  const [meta] = await db.query<{ dim: number }>(projectId, "SELECT dim FROM vec_meta WHERE name = ?", [name]);
  if (meta && meta.dim !== dim) await db.exec(projectId, `DROP TABLE IF EXISTS ${name}`);
  await db.exec(projectId, `CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING vec0(embedding float[${Math.trunc(dim)}] distance_metric=cosine)`);
  await db.exec(projectId, "INSERT OR REPLACE INTO vec_meta(name, dim) VALUES(?, ?)", [name, dim]);
}

// vec0 has no upsert: delete then insert.
export async function upsert(projectId: string, name: string, rows: { rowid: number; vector: number[] }[]): Promise<void> {
  table(name);
  await db.batch(projectId, rows.flatMap((r) => [
    { sql: `DELETE FROM ${name} WHERE rowid = ?`, params: [r.rowid] },
    { sql: `INSERT INTO ${name}(rowid, embedding) VALUES(?, ?)`, params: [r.rowid, JSON.stringify(r.vector)] },
  ]));
}

export function knn(projectId: string, name: string, vector: number[], k: number): Promise<{ rowid: number; distance: number }[]> {
  table(name);
  return db.query(projectId, `SELECT rowid, distance FROM ${name} WHERE embedding MATCH ? AND k = ? ORDER BY distance`, [JSON.stringify(vector), k]);
}

export const vectors = { ensure, upsert, knn };
