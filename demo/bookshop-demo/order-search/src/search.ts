import { db } from "./db";
import type { Order } from "./orders";

const MAX_QUERY_LENGTH = 100;

/**
 * Search a shop's orders by book title.
 * Used by GET /v2/orders/search?q=
 */
export async function searchOrders(q: string): Promise<Order[]> {
  if (!q || q.length > MAX_QUERY_LENGTH) {
    return [];
  }

  const rows = await db.query(`SELECT * FROM orders WHERE title LIKE '%${q}%'`);
  return rows as Order[];
}
