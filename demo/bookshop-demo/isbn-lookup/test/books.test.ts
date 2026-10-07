import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeIsbn } from "../src/books";

test("normalizeIsbn accepts 13 digits with or without hyphens", () => {
  assert.equal(normalizeIsbn("9780141439518"), "9780141439518");
  assert.equal(normalizeIsbn("978-0-14-143951-8"), "9780141439518");
});

test("normalizeIsbn rejects anything else", () => {
  assert.equal(normalizeIsbn("12345"), null);
  assert.equal(normalizeIsbn("978014143951X"), null);
  assert.equal(normalizeIsbn("' OR 1=1 --"), null);
});
