import { db } from "./db";

export interface User {
  id: number;
  name: string;
  email: string;
}

export async function getUser(id: number): Promise<User | undefined> {
  const rows = await db.query("SELECT id, name, email FROM users WHERE id = ?", [id]);
  return rows[0] as User | undefined;
}

// What the API sends back for a user. Email stays private.
export function toUserResponse(u: User) {
  return { user: { id: u.id, fullName: u.name } };
}
