-- ClosedBook D1 schema (SQLite)
-- Apply: wrangler d1 execute closedbook --local  --file=db/schema.sql
--        wrangler d1 execute closedbook --remote --file=db/schema.sql

PRAGMA foreign_keys = ON;

-- A field of study the user wants to learn.
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  phase       INTEGER NOT NULL DEFAULT 0, -- 0=sources, 1=map, 2=controversies, 3=test, 4=gaps
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Uploaded materials. Original files live in R2 (r2_key); text is chunked below.
CREATE TABLE IF NOT EXISTS sources (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'other', -- textbook | paper | slides | other
  r2_key     TEXT,
  page_count INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Text chunks extracted from sources. Embeddings live in Vectorize,
-- keyed by chunk id. Keep page/chapter so every claim can cite its source.
CREATE TABLE IF NOT EXISTS chunks (
  id         TEXT PRIMARY KEY,
  source_id  TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  text       TEXT NOT NULL,
  page       INTEGER,
  chapter    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chunks_project ON chunks(project_id);

-- Phase 1 output: the knowledge skeleton. citations = JSON array of chunk ids.
CREATE TABLE IF NOT EXISTS knowledge_nodes (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  layer       TEXT NOT NULL DEFAULT 'core', -- foundation | core | branch
  description TEXT,
  citations   TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS knowledge_edges (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_node  TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  to_node    TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  relation   TEXT NOT NULL, -- prerequisite | causal | contrast | part_of
  citations  TEXT NOT NULL DEFAULT '[]'
);

-- Phase 2 output: real disagreements found in the sources.
-- positions = JSON array: { stance, claims, evidence, rebuttal, citations }
CREATE TABLE IF NOT EXISTS controversies (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  topic      TEXT NOT NULL,
  summary    TEXT,
  positions  TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Phase 3: generated questions. model_answer and rubric are SERVER-SIDE ONLY:
-- never return them to the client before grading is complete.
CREATE TABLE IF NOT EXISTS questions (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  body         TEXT NOT NULL,
  tag          TEXT NOT NULL DEFAULT 'concept', -- concept | causal | application | controversy
  model_answer TEXT NOT NULL,
  rubric       TEXT NOT NULL DEFAULT '[]', -- JSON: grading viewpoints
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The user's own answers, written with sources locked (closed book).
CREATE TABLE IF NOT EXISTS attempts (
  id          TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  answer      TEXT NOT NULL,
  locked      INTEGER NOT NULL DEFAULT 1, -- 1 = answered under source lock
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Grading focuses on what is missing and what is shallow,
-- not just right/wrong. missing_points / shallow_points = JSON arrays.
CREATE TABLE IF NOT EXISTS grades (
  id             TEXT PRIMARY KEY,
  attempt_id     TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  scores         TEXT NOT NULL DEFAULT '{}', -- JSON per rubric viewpoint
  missing_points TEXT NOT NULL DEFAULT '[]',
  shallow_points TEXT NOT NULL DEFAULT '[]',
  followup       TEXT, -- one "why / what if" follow-up question, if shallow
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Phase 4: tracked understanding gaps, closed only by a passing retest.
CREATE TABLE IF NOT EXISTS gaps (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  concept         TEXT NOT NULL,
  detail          TEXT,
  status          TEXT NOT NULL DEFAULT 'open', -- open | retesting | closed
  origin_grade_id TEXT REFERENCES grades(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_gaps_project_status ON gaps(project_id, status);
