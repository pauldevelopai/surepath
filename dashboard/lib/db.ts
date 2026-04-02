import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export default pool;

export async function query(text: string, params?: unknown[]) {
  const res = await pool.query(text, params);
  return res.rows;
}
