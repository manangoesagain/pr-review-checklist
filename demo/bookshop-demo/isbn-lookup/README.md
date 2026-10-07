# Bookshop API

A small, fictional bookshop API. It exists to demo pull request reviews with PR Review Checklist; none of this code runs anywhere real.

## Endpoints

| Method | Path | Returns |
|---|---|---|
| GET | `/v1/books` | All books, sorted by title |
| GET | `/v1/books/:isbn` | One book by its 13-digit ISBN, or 404 |
| GET | `/v1/orders?userId=1` | A user's orders, each with its items |
| GET | `/v1/users/:id` | `{ "id": 1, "name": "Ada" }` |

## Run it

```bash
npm install
npm start
```

The API listens on http://localhost:3000. Set `DB_PATH` to use a different database file.

## Test it

```bash
npm test
```
