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

// ISBN-13: 13 digits, optionally split by hyphens.
export function normalizeIsbn(input: string): string | null {
  const digits = input.replace(/-/g, "");
  return /^\d{13}$/.test(digits) ? digits : null;
}

export async function getBookByIsbn(isbn: string): Promise<Book | undefined> {
  const rows = await db.query(
    "SELECT id, title, author, isbn, price FROM books WHERE isbn = ?",
    [isbn]
  );
  return rows[0] as Book | undefined;
}
