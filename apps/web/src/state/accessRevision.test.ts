import { describe, expect, it } from "vite-plus/test";

import { advanceAccessRevision } from "./accessRevision";

describe("advanceAccessRevision", () => {
  it("records the initial revision without triggering a redundant refresh", () => {
    expect(advanceAccessRevision(null, { snapshotRevision: 3, sessionRevision: 3 })).toEqual({
      nextRevision: 3,
      refreshSession: false,
      refreshMembers: false,
    });
  });

  it("refreshes both session and members when the access snapshot revision advances", () => {
    expect(advanceAccessRevision(3, { snapshotRevision: 4, sessionRevision: 3 })).toEqual({
      nextRevision: 4,
      refreshSession: true,
      refreshMembers: true,
    });
  });

  it("does not trigger a duplicate member refresh when session catches up to the same revision", () => {
    expect(advanceAccessRevision(4, { snapshotRevision: 4, sessionRevision: 4 })).toEqual({
      nextRevision: 4,
      refreshSession: false,
      refreshMembers: false,
    });
  });

  it("refreshes members when session state observes a newer revision on its own", () => {
    expect(advanceAccessRevision(4, { snapshotRevision: undefined, sessionRevision: 5 })).toEqual({
      nextRevision: 5,
      refreshSession: false,
      refreshMembers: true,
    });
  });

  it("ignores older or missing revisions", () => {
    expect(advanceAccessRevision(5, { snapshotRevision: 4, sessionRevision: 3 })).toEqual({
      nextRevision: 5,
      refreshSession: false,
      refreshMembers: false,
    });
    expect(
      advanceAccessRevision(null, { snapshotRevision: undefined, sessionRevision: undefined }),
    ).toEqual({
      nextRevision: null,
      refreshSession: false,
      refreshMembers: false,
    });
  });
});
