import { test } from "node:test";
import assert from "node:assert/strict";
import { toUserResponse } from "../src/users";

test("toUserResponse keeps the email private", () => {
  const response = toUserResponse({ id: 1, name: "Ada", email: "ada@example.com" });
  assert.deepEqual(response, { id: 1, name: "Ada" });
});
