import type { Db, Sql } from '../db/client';

/** Shared dependencies passed to domain services (web and worker). */
export interface Ctx {
  db: Db;
  sql: Sql;
}
