// PostgreSQL connection layer for the staged OTW Logistics migration.
// This module is intentionally separate from the current SQLite server.
import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing from backend/.env");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase requires TLS. For production, retain certificate verification
  // where the host's CA configuration supports it.
  ssl: { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: "otw-logistics-backend",
});

pool.on("error", (error) => {
  console.error("Unexpected idle PostgreSQL client error:", error.message);
});

export async function query(text, values = []) {
  return pool.query(text, values);
}

export async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export async function checkPostgresConnection() {
  const result = await query(
    "SELECT current_database() AS database, current_user AS connected_user, NOW() AS server_time"
  );
  return result.rows[0];
}

export async function closePostgres() {
  await pool.end();
}
