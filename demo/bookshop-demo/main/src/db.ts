import Database from "better-sqlite3";

const sqlite = new Database(process.env.DB_PATH ?? "bookshop.db");

export const db = {
  async query(sql: string, params: unknown[] = []): Promise<unknown[]> {
    return sqlite.prepare(sql).all(...params);
  },
};
