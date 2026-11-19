-- Procurement agent schema. Idempotent: safe to apply repeatedly.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS policy_chunks (
    chunk_id          TEXT PRIMARY KEY,               -- "<policy_id>#<section>"
    policy_id         TEXT NOT NULL,
    title             TEXT NOT NULL,
    category          TEXT NOT NULL,
    version           TEXT NOT NULL,
    section           TEXT NOT NULL,
    heading           TEXT NOT NULL,
    text              TEXT NOT NULL,
    quarantined       BOOLEAN NOT NULL DEFAULT FALSE, -- flagged by the injection detector at ingest
    quarantine_reason TEXT,
    embedding         vector(384) NOT NULL,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS policy_chunks_embedding_idx
    ON policy_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS policy_chunks_category_idx ON policy_chunks (category);

CREATE TABLE IF NOT EXISTS budgets (
    department TEXT NOT NULL,
    category   TEXT NOT NULL,
    period     TEXT NOT NULL,                         -- "2026-Q4"
    allocated  NUMERIC(14, 2) NOT NULL,
    spent      NUMERIC(14, 2) NOT NULL DEFAULT 0,
    committed  NUMERIC(14, 2) NOT NULL DEFAULT 0,
    currency   CHAR(3) NOT NULL DEFAULT 'USD',
    PRIMARY KEY (department, category, period)
);

CREATE TABLE IF NOT EXISTS vendors (
    name           TEXT PRIMARY KEY,
    aliases        TEXT[] NOT NULL DEFAULT '{}',
    status         TEXT NOT NULL CHECK (status IN ('approved', 'pending', 'blacklisted')),
    categories     TEXT[] NOT NULL DEFAULT '{}',
    contract_until DATE,
    notes          TEXT
);
CREATE INDEX IF NOT EXISTS vendors_name_trgm_idx ON vendors USING gin (lower(name) gin_trgm_ops);

CREATE TABLE IF NOT EXISTS agent_runs (
    run_id         UUID PRIMARY KEY,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at    TIMESTAMPTZ,
    input_text     TEXT NOT NULL,
    status         TEXT,
    decision       TEXT,
    prompt_version TEXT NOT NULL,
    agent_model    TEXT,
    verifier_model TEXT,
    duration_ms    INTEGER,
    input_tokens   INTEGER NOT NULL DEFAULT 0,
    output_tokens  INTEGER NOT NULL DEFAULT 0,
    result         JSONB,
    human_decision JSONB                              -- filled by the approver (HITL)
);

CREATE TABLE IF NOT EXISTS agent_steps (
    id            BIGSERIAL PRIMARY KEY,
    run_id        UUID NOT NULL REFERENCES agent_runs (run_id) ON DELETE CASCADE,
    seq           INTEGER NOT NULL,
    node          TEXT NOT NULL,                      -- graph node
    kind          TEXT NOT NULL,                      -- llm | tool | guard | rule | info
    name          TEXT NOT NULL,
    input         JSONB,
    output        JSONB,
    error         TEXT,
    duration_ms   INTEGER,
    input_tokens  INTEGER,
    output_tokens INTEGER,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, seq)
);
