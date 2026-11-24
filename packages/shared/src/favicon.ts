// External favicon lookups are disabled in V3 Code; accept inline data: URLs only.
function inlineDataFaviconUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl || rawUrl.length > 4096) return null;
  try {
    const url = new URL(rawUrl);
    return url.protocol === "data:" ? url.href : null;
  } catch {
    return null;
  }
}

export function toolActivityFaviconUrl(
  icon: {
    readonly pageUrl: string;
    readonly faviconUrl?: string | undefined;
    readonly faviconUrlDark?: string | undefined;
  },
  appearance: "light" | "dark",
  _size = 32,
): string | null {
  if (appearance === "dark") {
    return inlineDataFaviconUrl(icon.faviconUrlDark) ?? inlineDataFaviconUrl(icon.faviconUrl);
  }
  return inlineDataFaviconUrl(icon.faviconUrl);
}

export function faviconUrlForOrigin(_rawUrl: string | null | undefined, _size = 32): string | null {
  return null;
}
