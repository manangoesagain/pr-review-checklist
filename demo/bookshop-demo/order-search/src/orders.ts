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

// Simpler to read: load the orders, then each order's items.
export async function getUserOrders(userId: number): Promise<Order[]> {
  const orders = (await db.query(
    "SELECT id, user_id AS userId, title, total FROM orders WHERE user_id = ?",
    [userId]
  )) as Order[];

  for (const order of orders) {
    order.items = (await db.query(
      "SELECT book_id AS bookId, qty FROM order_items WHERE order_id = ?",
      [order.id]
    )) as OrderItem[];
  }

  return orders;
}
