// computeRoom against the plan figures: the Firm plan's 50 documents per matter and a limit of 10
// open matters unless a test says otherwise, -1 for unlimited, and 0 for a plan without Matters.

import { describe, expect, it } from "vitest";
import { MAX_FILES_PER_CALL } from "../files/resolve";
import { computeRoom } from "./room";

const FIRM = { docsPerMatter: 50, activeMatters: 10 };

describe("computeRoom", () => {
  it("gives a new matter on the Firm plan room for 50", () => {
    expect(computeRoom({ entitlements: FIRM, openMatters: 3, linkedHeld: null })).toStrictEqual({
      perMatter: 50,
      held: 0,
      room: 50,
      activeMatters: { limit: 10, open: 3 },
      canCreate: true,
    });
  });

  it("gives a linked matter holding 44 room for 6", () => {
    const room = computeRoom({ entitlements: FIRM, openMatters: 3, linkedHeld: 44 });
    expect(room.held).toBe(44);
    expect(room.room).toBe(6);
  });

  it("gives a full linked matter no room", () => {
    expect(computeRoom({ entitlements: FIRM, openMatters: 3, linkedHeld: 50 }).room).toBe(0);
  });

  it("never gives negative room when a linked matter holds more than the limit", () => {
    const room = computeRoom({ entitlements: FIRM, openMatters: 3, linkedHeld: 60 });
    expect(room.held).toBe(60);
    expect(room.room).toBe(0);
  });

  it("caps an unlimited plan at MAX_FILES_PER_CALL", () => {
    const room = computeRoom({
      entitlements: { docsPerMatter: -1, activeMatters: -1 },
      openMatters: 250,
      linkedHeld: 1_000,
    });
    expect(MAX_FILES_PER_CALL).toBe(100);
    expect(room).toStrictEqual({
      perMatter: null,
      held: 1_000,
      room: 100,
      activeMatters: { limit: null, open: 250 },
      canCreate: true,
    });
  });

  it("caps a large per-matter limit at MAX_FILES_PER_CALL", () => {
    const room = computeRoom({ entitlements: { docsPerMatter: 500, activeMatters: 10 }, openMatters: 0, linkedHeld: 20 });
    expect(room.room).toBe(MAX_FILES_PER_CALL);
  });

  it("refuses a new matter when 10 of 10 are open", () => {
    const room = computeRoom({ entitlements: FIRM, openMatters: 10, linkedHeld: null });
    expect(room.activeMatters).toStrictEqual({ limit: 10, open: 10 });
    expect(room.canCreate).toBe(false);
  });

  it("still gives a linked matter its room when 10 of 10 are open, since it needs no new matter", () => {
    const room = computeRoom({ entitlements: FIRM, openMatters: 10, linkedHeld: 44 });
    expect(room.canCreate).toBe(false);
    expect(room.room).toBe(6);
  });

  it("gives a plan without Matters (0 documents per matter) no room", () => {
    const room = computeRoom({ entitlements: { docsPerMatter: 0, activeMatters: 0 }, openMatters: 0, linkedHeld: null });
    expect(room.perMatter).toBe(0);
    expect(room.room).toBe(0);
    expect(room.canCreate).toBe(false);
  });
});
