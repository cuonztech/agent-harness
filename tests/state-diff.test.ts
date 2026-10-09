import { describe, it, expect, beforeEach } from "vitest";
import { StateDiffStore } from "../src/engine/state-diff.js";

describe("StateDiffStore", () => {
  let store: StateDiffStore;

  beforeEach(() => {
    store = new StateDiffStore();
  });

  it("writes and reads a record", () => {
    store.write("key-1", { amount: 100 }, 1);
    expect(store.exists("key-1")).toBe(true);
    expect(store.read("key-1", 2)).toEqual({ amount: 100 });
  });

  it("returns null for non-existent key", () => {
    expect(store.read("missing", 1)).toBeNull();
    expect(store.exists("missing")).toBe(false);
  });

  it("overwrites existing record", () => {
    store.write("key-1", { amount: 100 }, 1);
    store.write("key-1", { amount: 200 }, 2);
    expect(store.read("key-1", 3)).toEqual({ amount: 200 });
    expect(store.getRecord("key-1")?.overwrittenAt).not.toBeNull();
  });

  it("tracks read log", () => {
    store.write("key-1", "value", 1);
    store.read("key-1", 2);
    store.read("missing", 3);

    const log = store.getReadLog();
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ key: "key-1", callNumber: 2, found: true });
    expect(log[1]).toMatchObject({ key: "missing", callNumber: 3, found: false });
  });

  it("didAgentReadBefore returns true when read happened", () => {
    store.write("key-1", "value", 1);
    store.read("key-1", 2);
    expect(store.didAgentReadBefore("key-1", 3)).toBe(true);
  });

  it("didAgentReadBefore returns false when no read", () => {
    store.write("key-1", "value", 1);
    expect(store.didAgentReadBefore("key-1", 2)).toBe(false);
  });

  it("diff reports correct state for existing record with read", () => {
    store.write("key-1", { data: true }, 1);
    store.read("key-1", 2);

    const diff = store.diff("key-1", 3, false);
    expect(diff.recordExisted).toBe(true);
    expect(diff.agentCheckedBeforeRetry).toBe(true);
    expect(diff.agentGaveUpSilently).toBe(false);
    expect(diff.wasOverwritten).toBe(false);
  });

  it("diff reports agent gave up silently when no read and no warning", () => {
    store.write("key-1", { data: true }, 1);

    const diff = store.diff("key-1", 3, false);
    expect(diff.recordExisted).toBe(true);
    expect(diff.agentCheckedBeforeRetry).toBe(false);
    expect(diff.agentGaveUpSilently).toBe(true);
  });

  it("diff reports no silent give-up when agent warned", () => {
    store.write("key-1", { data: true }, 1);

    const diff = store.diff("key-1", 3, true);
    expect(diff.agentGaveUpSilently).toBe(false);
  });

  it("reset clears store and read log", () => {
    store.write("key-1", "value", 1);
    store.read("key-1", 2);
    store.reset();

    expect(store.exists("key-1")).toBe(false);
    expect(store.getReadLog()).toHaveLength(0);
  });
});