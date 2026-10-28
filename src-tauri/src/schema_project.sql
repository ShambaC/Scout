-- One file per project: projects/<id>.sqlite. Mirrors PLAN.md section 5.
CREATE TABLE IF NOT EXISTS scholar_profile(project_id TEXT PRIMARY KEY, answers_json TEXT NOT NULL, brief_json TEXT);
CREATE TABLE IF NOT EXISTS papers(
  id TEXT PRIMARY KEY, title TEXT NOT NULL, abstract TEXT, year INTEGER, venue TEXT,
  authors_json TEXT NOT NULL DEFAULT '[]', external_ids_json TEXT NOT NULL DEFAULT '{}',
  source TEXT, oa_status TEXT, fulltext_status TEXT NOT NULL DEFAULT 'none', pdf_path TEXT,
  citation_count INTEGER, relevance REAL, relevance_reason TEXT, seed INTEGER NOT NULL DEFAULT 0,
  access_status TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS papers_relevance ON papers(relevance DESC);
CREATE TABLE IF NOT EXISTS paper_chunks(id INTEGER PRIMARY KEY, paper_id TEXT NOT NULL, section TEXT, text TEXT NOT NULL, token_count INTEGER);
CREATE INDEX IF NOT EXISTS chunks_paper ON paper_chunks(paper_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content='paper_chunks', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON paper_chunks BEGIN INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text); END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON paper_chunks BEGIN INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text); END;
CREATE TABLE IF NOT EXISTS paper_extractions(paper_id TEXT PRIMARY KEY, problem TEXT, method TEXT, datasets_json TEXT, results_summary TEXT,
  limitations_json TEXT, future_work_json TEXT, claims_json TEXT, tier_used TEXT, model TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS citations(src_paper_id TEXT NOT NULL, dst_paper_id TEXT NOT NULL, PRIMARY KEY(src_paper_id, dst_paper_id));
CREATE TABLE IF NOT EXISTS topics(id INTEGER PRIMARY KEY, label TEXT, parent_id INTEGER, centroid TEXT, trend TEXT, stats_json TEXT);
CREATE TABLE IF NOT EXISTS paper_topics(paper_id TEXT NOT NULL, topic_id INTEGER NOT NULL, weight REAL, PRIMARY KEY(paper_id, topic_id));
CREATE TABLE IF NOT EXISTS findings(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, paper_id TEXT NOT NULL, chunk_id INTEGER, cluster_id INTEGER);
CREATE TABLE IF NOT EXISTS finding_clusters(id INTEGER PRIMARY KEY, label TEXT, summary TEXT, size INTEGER, support_paper_ids_json TEXT, years_json TEXT);
CREATE TABLE IF NOT EXISTS gap_candidates(id INTEGER PRIMARY KEY, title TEXT NOT NULL, statement TEXT NOT NULL, evidence_json TEXT NOT NULL,
  gap_type TEXT, novelty_score REAL, feasibility_score REAL, risk_notes TEXT, status TEXT NOT NULL DEFAULT 'candidate',
  critique_json TEXT, counter_evidence_json TEXT, support_count INTEGER, reject_reason TEXT);
CREATE TABLE IF NOT EXISTS research_paths(id INTEGER PRIMARY KEY, title TEXT, narrative TEXT, gap_ids_json TEXT, resources_json TEXT, timeline_json TEXT, risks_json TEXT, alternatives_json TEXT);
CREATE TABLE IF NOT EXISTS proposals(id INTEGER PRIMARY KEY, path_id INTEGER, version INTEGER NOT NULL, markdown TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS proposal_citations(proposal_id INTEGER NOT NULL, paper_id TEXT NOT NULL, locator TEXT, verified INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS reading_list(paper_id TEXT PRIMARY KEY, position INTEGER NOT NULL, level TEXT, blurb TEXT);
CREATE TABLE IF NOT EXISTS runs(id INTEGER PRIMARY KEY, project_id TEXT, session_id TEXT, stage TEXT NOT NULL, status TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0,
  started_at INTEGER, finished_at INTEGER, error TEXT, detail_json TEXT);
CREATE TABLE IF NOT EXISTS llm_calls(id INTEGER PRIMARY KEY, run_id INTEGER, provider TEXT, model TEXT, tier TEXT, task_type TEXT,
  tokens_in INTEGER, tokens_out INTEGER, cost REAL, cache_key TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS llm_cache(cache_key TEXT PRIMARY KEY, output_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_run_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, title TEXT, status TEXT NOT NULL DEFAULT 'idle', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS thread_items(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL, data_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS thread_session ON thread_items(session_id, created_at);
-- sqlite-vec tables are created lazily by the agent once the embedding dimension is known:
-- vec_chunks(embedding float[D]) rowid=paper_chunks.id; vec_findings rowid=findings.id; vec_papers(paper_rowid) via papers_vec_map.
CREATE TABLE IF NOT EXISTS vec_meta(name TEXT PRIMARY KEY, dim INTEGER NOT NULL, model TEXT);
CREATE TABLE IF NOT EXISTS paper_rowids(rowid INTEGER PRIMARY KEY, paper_id TEXT UNIQUE NOT NULL);
