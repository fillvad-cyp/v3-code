import type { ThemeDefinition } from "./themePalette";

export type OpenVsxThemeSort = "downloadCount" | "rating" | "timestamp" | "relevance";

export type OpenVsxThemeExtension = {
  id: string;
  collectionId: string;
  name: string;
  publisher: string;
  description: string;
  downloadCount: number;
  iconUrl: string | null;
  sourceUrl: string | null;
  manifestUrl: string;
  sha256Url: string;
  vsixUrl: string;
  version: string;
  license: string;
};

export type OpenVsxThemeSearchOptions = {
  signal?: AbortSignal;
  sortBy?: OpenVsxThemeSort;
};

export async function searchOpenVsxThemes(
  _query: string,
  _options: OpenVsxThemeSearchOptions = {},
): Promise<OpenVsxThemeExtension[]> {
  return [];
}

export async function importOpenVsxThemeExtension(
  _extension: OpenVsxThemeExtension,
  _signal?: AbortSignal,
): Promise<ReadonlyArray<ThemeDefinition>> {
  throw new Error(
    "Remote Open VSX theme downloads are disabled in V3 Code. Import local JSON themes instead.",
  );
}
