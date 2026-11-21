import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const stagingTestMode = process.env.AMAN_STAGING_TESTS === "1";
if (stagingTestMode && process.env.NODE_ENV === "production") {
  throw new Error("Staging integration tests cannot run in production.");
}

const connectionString = stagingTestMode
  ? process.env.STAGING_DATABASE_URL
  : process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    stagingTestMode
      ? "STAGING_DATABASE_URL is required for staging integration tests."
      : "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString });
export const db = drizzle(pool, { schema });

export * from "./schema";
