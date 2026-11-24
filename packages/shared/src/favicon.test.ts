import { describe, expect, it } from "@effect/vitest";

import { faviconUrlForOrigin, toolActivityFaviconUrl } from "./favicon.ts";

describe("faviconUrlForOrigin", () => {
  it("never issues external favicon lookups for any origin", () => {
    expect(
      faviconUrlForOrigin("https://github.com:8443/pingdotgg/t3code?private=query", 64),
    ).toBeNull();
    expect(faviconUrlForOrigin("https://example.com", 32)).toBeNull();
    expect(faviconUrlForOrigin("http://localhost:3873", 32)).toBeNull();
  });

  it.each([null, undefined, "invalid URL", "file:///tmp/private"])(
    "returns null for missing or non-http origin %s",
    (origin) => {
      expect(faviconUrlForOrigin(origin)).toBeNull();
    },
  );
});

describe("toolActivityFaviconUrl", () => {
  it("never fetches third-party or page origin favicons over the network", () => {
    expect(
      toolActivityFaviconUrl({ pageUrl: "https://example.com/docs/page?q=1" }, "light"),
    ).toBeNull();
    expect(toolActivityFaviconUrl({ pageUrl: "http://localhost:5173/app" }, "light")).toBeNull();
    expect(
      toolActivityFaviconUrl(
        { pageUrl: "https://example.com/docs", faviconUrl: "https://example.com/icon.png" },
        "light",
      ),
    ).toBeNull();
    expect(
      toolActivityFaviconUrl(
        { pageUrl: "https://example.com/docs", faviconUrl: "chrome-extension://example/_favicon/" },
        "light",
      ),
    ).toBeNull();
  });

  it("allows inline data URLs only and selects dark variant when present", () => {
    const lightData = "data:image/png;base64,AAAA";
    const darkData = "data:image/png;base64,BBBB";
    expect(
      toolActivityFaviconUrl(
        { pageUrl: "https://example.com/docs", faviconUrl: lightData, faviconUrlDark: darkData },
        "light",
      ),
    ).toBe(lightData);
    expect(
      toolActivityFaviconUrl(
        { pageUrl: "https://example.com/docs", faviconUrl: lightData, faviconUrlDark: darkData },
        "dark",
      ),
    ).toBe(darkData);
    expect(
      toolActivityFaviconUrl(
        { pageUrl: "https://example.com/docs", faviconUrl: lightData },
        "dark",
      ),
    ).toBe(lightData);
  });
});
