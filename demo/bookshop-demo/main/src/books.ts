import { db } from "./db";

export interface Book {
  id: number;
  title: string;
  author: string;
  isbn: string;
  price: number;
}

export async function listBooks(): Promise<Book[]> {
  const rows = await db.query("SELECT id, title, author, isbn, price FROM books ORDER BY title");
  return rows as Book[];
}
