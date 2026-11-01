PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
INSERT OR IGNORE INTO schema_version(version) VALUES (1);
CREATE TABLE IF NOT EXISTS papers (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, authors TEXT NOT NULL DEFAULT '[]',
  year INTEGER, abstract TEXT NOT NULL DEFAULT '', source_url TEXT NOT NULL DEFAULT '',
  doi TEXT NOT NULL DEFAULT '', arxiv_id TEXT NOT NULL DEFAULT '', arxiv_version INTEGER,
  reading_status TEXT NOT NULL CHECK(reading_status IN ('unread','reading','read')),
  revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS papers_doi_unique ON papers(doi) WHERE doi != '';
CREATE UNIQUE INDEX IF NOT EXISTS papers_arxiv_unique ON papers(arxiv_id) WHERE arxiv_id != '';
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, paper_id TEXT NOT NULL REFERENCES papers(id),
  relative_path TEXT NOT NULL UNIQUE, filename TEXT NOT NULL, mime_type TEXT NOT NULL,
  sha256 TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY, paper_id TEXT NOT NULL REFERENCES papers(id),
  attachment_id TEXT NOT NULL REFERENCES attachments(id), kind TEXT NOT NULL,
  page_index INTEGER NOT NULL CHECK(page_index >= 0), page_label TEXT NOT NULL,
  rects TEXT NOT NULL, selected_text TEXT NOT NULL, comment TEXT NOT NULL,
  color TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('paper','topic','idea')),
  revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
  note_id TEXT NOT NULL REFERENCES notes(id), revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_contents (
  id TEXT PRIMARY KEY, paper_id TEXT NOT NULL REFERENCES papers(id), kind TEXT NOT NULL,
  body TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, source_scope TEXT NOT NULL,
  source_attachment_id TEXT REFERENCES attachments(id), source_page_indices TEXT NOT NULL,
  source_text TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE);
CREATE TABLE IF NOT EXISTS relations (
  id TEXT PRIMARY KEY, from_type TEXT NOT NULL, from_id TEXT NOT NULL,
  to_type TEXT NOT NULL, to_id TEXT NOT NULL, purpose TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(from_type,from_id,to_type,to_id,purpose)
);
CREATE INDEX IF NOT EXISTS relations_destination ON relations(to_type,to_id);
CREATE INDEX IF NOT EXISTS relations_source ON relations(from_type,from_id);
CREATE TABLE IF NOT EXISTS reading_positions (
  attachment_id TEXT PRIMARY KEY REFERENCES attachments(id),
  paper_id TEXT NOT NULL REFERENCES papers(id), page_index INTEGER NOT NULL,
  scale TEXT NOT NULL, rotation INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK(id=1), ai_provider TEXT NOT NULL DEFAULT 'none',
  ollama_url TEXT NOT NULL DEFAULT 'http://127.0.0.1:11434',
  ollama_model TEXT NOT NULL DEFAULT 'qwen3:8b', openai_url TEXT NOT NULL DEFAULT '',
  openai_model TEXT NOT NULL DEFAULT '', appearance TEXT NOT NULL DEFAULT 'light',
  split_ratio REAL NOT NULL DEFAULT 0.6
);
INSERT OR IGNORE INTO settings(id) VALUES (1);
