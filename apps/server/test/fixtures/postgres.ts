import { randomUUID } from "node:crypto";
import { Pool } from "pg";

export interface PostgresTestDatabase {
  connectionString: string;
  schema: string;
  cleanup(): Promise<void>;
}

export async function createPostgresTestDatabase(): Promise<PostgresTestDatabase | undefined> {
  const rootConnectionString = process.env.SECOPS_TEST_DATABASE_URL?.trim();
  if (!rootConnectionString) {
    return undefined;
  }
  const schema = `secops_test_${randomUUID().replaceAll("-", "_")}`;
  const rootPool = new Pool({ connectionString: rootConnectionString });
  await rootPool.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
  await rootPool.end();
  const separator = rootConnectionString.includes("?") ? "&" : "?";
  const connectionString = `${rootConnectionString}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
  return {
    connectionString,
    schema,
    async cleanup() {
      const cleanupPool = new Pool({ connectionString: rootConnectionString });
      try {
        await cleanupPool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
      } finally {
        await cleanupPool.end();
      }
    }
  };
}

function quoteIdent(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
