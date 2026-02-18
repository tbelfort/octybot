/**
 * Tests for the SQLite MessageBus.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MessageBus } from "../src/delegation/bus";
import { unlinkSync, existsSync } from "fs";
import { join } from "path";

const TEST_DB = join(import.meta.dir, ".test-bus.db");

let bus: MessageBus;

beforeEach(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  bus = new MessageBus(TEST_DB);
});

afterEach(() => {
  bus.close();
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  // Clean up WAL files
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

describe("MessageBus", () => {
  it("send + claim + respond cycle", () => {
    const id = bus.send("main", "researcher", "Find info about topic X");

    // Message exists in pending state
    const msg = bus.get(id);
    expect(msg).not.toBeNull();
    expect(msg!.status).toBe("pending");
    expect(msg!.from_agent).toBe("main");
    expect(msg!.to_agent).toBe("researcher");

    // Claim the message
    const claimed = bus.claim("researcher");
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(id);
    expect(claimed!.status).toBe("claimed");

    // No more messages to claim
    const noClaim = bus.claim("researcher");
    expect(noClaim).toBeNull();

    // Respond
    bus.respond(id, "Here is the info about topic X");

    const responded = bus.get(id);
    expect(responded!.status).toBe("responded");
    expect(responded!.response).toBe("Here is the info about topic X");
  });

  it("claim returns null when no messages", () => {
    const result = bus.claim("nobody");
    expect(result).toBeNull();
  });

  it("claim is agent-specific", () => {
    bus.send("main", "researcher", "Task for researcher");
    bus.send("main", "writer", "Task for writer");

    // Researcher can only claim their message
    const claimed = bus.claim("researcher");
    expect(claimed).not.toBeNull();
    expect(claimed!.to_agent).toBe("researcher");

    // Writer can claim their message
    const writerClaimed = bus.claim("writer");
    expect(writerClaimed).not.toBeNull();
    expect(writerClaimed!.to_agent).toBe("writer");
  });

  it("respond fails on non-claimed message", () => {
    const id = bus.send("main", "researcher", "task");

    expect(() => bus.respond(id, "response")).toThrow("not in 'claimed' state");
  });

  it("waitForResponse resolves when response arrives", async () => {
    const id = bus.send("main", "researcher", "task");

    // Simulate async claim + respond
    setTimeout(() => {
      bus.claim("researcher");
      bus.respond(id, "done");
    }, 50);

    const result = await bus.waitForResponse(id, 5000, 25);
    expect(result).not.toBeNull();
    expect(result!.response).toBe("done");
  });

  it("waitForResponse times out", async () => {
    const id = bus.send("main", "researcher", "task");

    const result = await bus.waitForResponse(id, 100, 25);
    expect(result).toBeNull();

    // Message should be expired
    const msg = bus.get(id);
    expect(msg!.status).toBe("expired");
  });

  it("list shows inbox and outbox", () => {
    bus.send("main", "researcher", "task 1");
    bus.send("main", "researcher", "task 2");
    bus.send("researcher", "main", "response");

    const inbox = bus.list("researcher", "inbox");
    expect(inbox.length).toBe(2);

    const outbox = bus.list("main", "outbox");
    expect(outbox.length).toBe(2);

    const researcherOutbox = bus.list("researcher", "outbox");
    expect(researcherOutbox.length).toBe(1);
  });

  it("list filters by status", () => {
    const id = bus.send("main", "researcher", "task");
    bus.claim("researcher");

    const pending = bus.list("researcher", "inbox", "pending");
    expect(pending.length).toBe(0);

    const claimed = bus.list("researcher", "inbox", "claimed");
    expect(claimed.length).toBe(1);
  });

  it("prune removes old responded messages", () => {
    const id = bus.send("main", "researcher", "task");
    bus.claim("researcher");
    bus.respond(id, "done");

    // Hack: set created_at to yesterday
    const yesterday = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    (bus as any).db.run(`UPDATE messages SET created_at = ? WHERE id = ?`, [yesterday, id]);

    const pruned = bus.prune(24 * 60 * 60 * 1000);
    expect(pruned).toBe(1);

    expect(bus.get(id)).toBeNull();
  });

  it("prune does not remove recent messages", () => {
    const id = bus.send("main", "researcher", "task");
    bus.claim("researcher");
    bus.respond(id, "done");

    const pruned = bus.prune();
    expect(pruned).toBe(0);
    expect(bus.get(id)).not.toBeNull();
  });

  it("TTL expires pending messages on claim", async () => {
    // Send with 50ms TTL
    const id = bus.send("main", "researcher", "urgent", 50);

    // Wait for expiry
    await new Promise(resolve => setTimeout(resolve, 100));

    // Claim should return null (message expired)
    const claimed = bus.claim("researcher");
    expect(claimed).toBeNull();

    const msg = bus.get(id);
    expect(msg!.status).toBe("expired");
  });

  it("FIFO ordering on claim", () => {
    bus.send("main", "researcher", "first");
    bus.send("main", "researcher", "second");
    bus.send("main", "researcher", "third");

    expect(bus.claim("researcher")!.content).toBe("first");
    expect(bus.claim("researcher")!.content).toBe("second");
    expect(bus.claim("researcher")!.content).toBe("third");
    expect(bus.claim("researcher")).toBeNull();
  });

  describe("claimById", () => {
    it("claims a specific message by ID", () => {
      const id1 = bus.send("main", "researcher", "first");
      const id2 = bus.send("main", "researcher", "second");

      // Claim the second message specifically
      const claimed = bus.claimById(id2);
      expect(claimed).not.toBeNull();
      expect(claimed!.id).toBe(id2);
      expect(claimed!.content).toBe("second");
      expect(claimed!.status).toBe("claimed");

      // First message is still pending
      const msg1 = bus.get(id1);
      expect(msg1!.status).toBe("pending");
    });

    it("returns null for non-existent message", () => {
      const result = bus.claimById("nonexistent-id");
      expect(result).toBeNull();
    });

    it("returns null for already-claimed message", () => {
      const id = bus.send("main", "researcher", "task");
      bus.claim("researcher");

      const result = bus.claimById(id);
      expect(result).toBeNull();
    });

    it("returns null for expired message", async () => {
      const id = bus.send("main", "researcher", "urgent", 50);

      // Wait for expiry
      await new Promise(resolve => setTimeout(resolve, 100));

      const result = bus.claimById(id);
      expect(result).toBeNull();

      // Verify it was marked expired
      const msg = bus.get(id);
      expect(msg!.status).toBe("expired");
    });
  });

  it("timestamps are consistent JS ISO format", () => {
    const id = bus.send("main", "researcher", "task");
    const msg = bus.get(id);
    expect(msg!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    const claimed = bus.claim("researcher");
    expect(claimed!.claimed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    bus.respond(id, "done");
    const responded = bus.get(id);
    expect(responded!.responded_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    // All timestamps should be comparable (same format)
    expect(new Date(msg!.created_at).getTime()).toBeLessThanOrEqual(
      new Date(responded!.responded_at!).getTime()
    );
  });
});
