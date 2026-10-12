import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;
export type Sql = postgres.Sql;

export interface Database {
  sql: Sql;
  db: Db;
  close(): Promise<void>;
}

export function createDatabase(url: string, max = 10): Database {
  const sql = postgres(url, { max, onnotice: () => undefined });
  const db = drizzle(sql, { schema });
  return {
    sql,
    db,
    close: () => sql.end({ timeout: 5 }),
  };
}

export async function runMigrations(url: string, migrationsFolder: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    // Serialise migrations between the web and worker services starting together.
    await sql`select pg_advisory_lock(424242)`;
    await migrate(drizzle(sql), { migrationsFolder });
  } finally {
    await sql`select pg_advisory_unlock(424242)`.catch(() => undefined);
    await sql.end({ timeout: 5 });
  }
}

export { schema };
