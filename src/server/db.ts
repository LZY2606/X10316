import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

export function createStore(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS materials (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      digest TEXT NOT NULL,
      created_seq INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS parameter_sets (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      payload TEXT NOT NULL,
      parent_id TEXT,
      created_seq INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS branches (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_seq INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL REFERENCES branches(id),
      parent_id TEXT REFERENCES events(id),
      seq INTEGER NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      param_version INTEGER NOT NULL,
      result TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_branch ON events(branch_id, seq);
  `);
  return db;
}
