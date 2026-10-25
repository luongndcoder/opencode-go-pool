import { expect, test } from "vitest";
import { classifyFailure } from "./failure.js";

test("rate limits and quotas classify as window", () => {
  expect(classifyFailure("HTTP 429 Too Many Requests")).toBe("window");
  expect(classifyFailure("rate limit exceeded, retry later")).toBe("window");
  expect(classifyFailure("You have hit your usage limit for opencode-go")).toBe("window");
  expect(classifyFailure("quota exhausted for this key")).toBe("window");
  expect(classifyFailure("you ran out of credits for this period")).toBe("window");
});

test("auth failures classify as auth", () => {
  expect(classifyFailure("HTTP 401 Unauthorized")).toBe("auth");
  expect(classifyFailure("invalid api key")).toBe("auth");
  expect(classifyFailure("api key expired")).toBe("auth");
  expect(classifyFailure("Forbidden", "403")).toBe("auth");
});

test("unrelated failures return null", () => {
  expect(classifyFailure("ECONNRESET")).toBeNull();
  expect(classifyFailure("model returned an empty response")).toBeNull();
  expect(classifyFailure("command timed out")).toBeNull();
});

test("entitlement / subscription errors classify as auth", () => {
  expect(classifyFailure("OpenCode Go subscription required.")).toBe("auth");
  expect(classifyFailure("EntitlementError: no active plan")).toBe("auth");
});
