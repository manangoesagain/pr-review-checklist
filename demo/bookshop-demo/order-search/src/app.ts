import express from "express";
import { listBooks } from "./books";
import { getUserOrders } from "./orders";
import { searchOrders } from "./search";
import { getUser, toUserResponse } from "./users";

export const app = express();
app.use(express.json());

app.get("/v1/books", async (_req, res) => {
  res.json(await listBooks());
});

app.get("/v1/orders", async (req, res) => {
  const userId = Number(req.query.userId);
  if (!Number.isInteger(userId)) {
    res.status(400).json({ error: "userId must be a number" });
    return;
  }
  res.json(await getUserOrders(userId));
});

app.get("/v2/orders/search", async (req, res) => {
  const q = String(req.query.q ?? "");
  res.json(await searchOrders(q));
});

app.get("/v1/users/:id", async (req, res) => {
  const user = await getUser(Number(req.params.id));
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.json(toUserResponse(user));
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Bookshop API on http://localhost:${port}`));
