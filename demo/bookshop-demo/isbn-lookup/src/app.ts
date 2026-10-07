import express from "express";
import { getBookByIsbn, listBooks, normalizeIsbn } from "./books";
import { getUserOrders } from "./orders";
import { getUser, toUserResponse } from "./users";

export const app = express();
app.use(express.json());

app.get("/v1/books", async (_req, res) => {
  res.json(await listBooks());
});

app.get("/v1/books/:isbn", async (req, res) => {
  const isbn = normalizeIsbn(req.params.isbn);
  if (!isbn) {
    res.status(400).json({ error: "ISBN must be 13 digits" });
    return;
  }
  const book = await getBookByIsbn(isbn);
  if (!book) {
    res.status(404).json({ error: "Book not found" });
    return;
  }
  res.json(book);
});

app.get("/v1/orders", async (req, res) => {
  const userId = Number(req.query.userId);
  if (!Number.isInteger(userId)) {
    res.status(400).json({ error: "userId must be a number" });
    return;
  }
  res.json(await getUserOrders(userId));
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
