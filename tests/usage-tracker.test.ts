import { describe, test, expect } from "bun:test";
import { UsageTracker } from "../src/memory/usage-tracker";

describe("UsageTracker", () => {
  test("two instances don't cross-contaminate", () => {
    const a = new UsageTracker();
    const b = new UsageTracker();
    a.trackTokens("l1", 100, 50);
    b.trackTokens("l2", 200, 75);

    expect(a.getUsage().l1_input).toBe(100);
    expect(a.getUsage().l2_input).toBe(0);
    expect(b.getUsage().l2_input).toBe(200);
    expect(b.getUsage().l1_input).toBe(0);
  });

  test("resetUsage clears only own state", () => {
    const a = new UsageTracker();
    const b = new UsageTracker();
    a.trackTokens("l1", 100, 50);
    b.trackTokens("l1", 200, 75);
    a.resetUsage();

    expect(a.getUsage().l1_input).toBe(0);
    expect(b.getUsage().l1_input).toBe(200);
  });
});
