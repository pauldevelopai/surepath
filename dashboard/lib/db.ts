import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  statement_timeout: 30000, // 30s max query time
  query_timeout: 30000,
  max: 10, // max connections
  idleTimeoutMillis: 30000,
});

export default pool;

export async function query(text: string, params?: unknown[]) {
  const res = await pool.query(text, params);
  return res.rows;
}
