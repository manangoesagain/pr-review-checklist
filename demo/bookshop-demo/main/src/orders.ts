import { db } from "./db";

export interface OrderItem {
  bookId: number;
  qty: number;
}

export interface Order {
  id: number;
  userId: number;
  title: string;
  total: number;
  items: OrderItem[];
}

// One query for the orders and their items, grouped per order.
export async function getUserOrders(userId: number): Promise<Order[]> {
  const rows = (await db.query(
    `SELECT o.id, o.user_id AS userId, o.title, o.total,
            json_group_array(json_object('bookId', i.book_id, 'qty', i.qty)) AS items
       FROM orders o
       LEFT JOIN order_items i ON i.order_id = o.id
      WHERE o.user_id = ?
      GROUP BY o.id`,
    [userId]
  )) as Array<Omit<Order, "items"> & { items: string }>;

  return rows.map((row) => ({ ...row, items: JSON.parse(row.items) }));
}
