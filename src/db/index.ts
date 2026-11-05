import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { migrations } from './migrations.js';

export type Params = SQLInputValue[] | [Record<string, SQLInputValue>];

let db: DatabaseSync | null = null;
const stmtCache = new Map<string, ReturnType<DatabaseSync['prepare']>>();
let txDepth = 0;

export function openDatabase(file: string): DatabaseSync {
  if (db) return db;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function closeDatabase() {
  stmtCache.clear();
  db?.close();
  db = null;
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error('Database not opened. Call openDatabase() first.');
  return db;
}

function stmt(sql: string) {
  let s = stmtCache.get(sql);
  if (!s) {
    s = getDb().prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

function bind(params: unknown[]): SQLInputValue[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p as SQLInputValue;
  });
}

export function all<T>(sql: string, ...params: unknown[]): T[] {
  return stmt(sql).all(...bind(params)) as unknown as T[];
}

export function get<T>(sql: string, ...params: unknown[]): T | undefined {
  return stmt(sql).get(...bind(params)) as unknown as T | undefined;
}

export function run(sql: string, ...params: unknown[]) {
  const r = stmt(sql).run(...bind(params));
  return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
}

/**
 * Runs fn inside a write transaction (BEGIN IMMEDIATE takes the write lock
 * up-front so availability checks + inserts are atomic). Nested calls join
 * the outer transaction.
 */
export function tx<T>(fn: () => T): T {
  const d = getDb();
  if (txDepth > 0) return fn();
  d.exec('BEGIN IMMEDIATE');
  txDepth++;
  try {
    const result = fn();
    d.exec('COMMIT');
    return result;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  } finally {
    txDepth--;
  }
}

function migrate(d: DatabaseSync) {
  const row = d.prepare('PRAGMA user_version').get() as { user_version: number };
  let version = row.user_version;
  for (let i = version; i < migrations.length; i++) {
    d.exec('BEGIN');
    try {
      d.exec(migrations[i]!);
      d.exec(`PRAGMA user_version = ${i + 1}`);
      d.exec('COMMIT');
      version = i + 1;
    } catch (err) {
      d.exec('ROLLBACK');
      throw new Error(`Migration ${i + 1} failed: ${(err as Error).message}`);
    }
  }
}
