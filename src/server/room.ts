// The limits of one init_matter call (§3), from the account's entitlements, the number of open
// matters and, in a linked folder, the documents the linked matter already holds. An entitlement of
// -1 means unlimited; room is never negative and never more than MAX_FILES_PER_CALL.

import { MAX_FILES_PER_CALL } from "../files/resolve";

/** The room a matter has for one call, and whether the account may open another matter. */
export interface Room {
  /** Documents a matter may hold; null when unlimited. */
  perMatter: number | null;
  /** Documents the linked matter holds; 0 for a new one. */
  held: number;
  /** Documents this call may add: perMatter − held, at least 0 and at most MAX_FILES_PER_CALL. */
  room: number;
  /** The open-matter limit (null when unlimited) and the matters open now. */
  activeMatters: { limit: number | null; open: number };
  /** Whether another matter may be opened. A linked folder needs none, so its callers ignore it. */
  canCreate: boolean;
}

/** Computes the Room for a new matter (`linkedHeld` null) or for the linked matter holding `linkedHeld` documents. */
export function computeRoom(input: {
  entitlements: { docsPerMatter: number; activeMatters: number };
  openMatters: number;
  linkedHeld: number | null;
}): Room {
  const { entitlements, openMatters, linkedHeld } = input;
  const perMatter = entitlements.docsPerMatter === -1 ? null : entitlements.docsPerMatter;
  const held = linkedHeld ?? 0;
  const room = perMatter === null ? MAX_FILES_PER_CALL : Math.min(Math.max(perMatter - held, 0), MAX_FILES_PER_CALL);
  const limit = entitlements.activeMatters === -1 ? null : entitlements.activeMatters;
  return {
    perMatter,
    held,
    room,
    activeMatters: { limit, open: openMatters },
    canCreate: limit === null || openMatters < limit,
  };
}
