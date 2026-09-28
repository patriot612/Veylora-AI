import { getSystemConfig } from "../config";

export type SearchProviderConfig = {
  primaryUrl: string;
  fallbackUrl?: string;
  enabled: boolean;
  maxQueryChars: number;
  language: string;
  categories: string;
  timeRange: string;
  safeSearch: number;
  authToken?: string;
};

export async function getSearchProviderConfig(
  db: D1Database,
  envPrimaryUrl?: string,
  envAuthToken?: string,
): Promise<SearchProviderConfig> {
  const [enabled, primary, fallback, maxQuery, language, categories, timeRange, safeSearch, token] = await Promise.all([
    getSystemConfig(db, "search.enabled"),
    getSystemConfig(db, "search.primary_url"),
    getSystemConfig(db, "search.fallback_url"),
    getSystemConfig(db, "search.max_query_chars"),
    getSystemConfig(db, "search.language"),
    getSystemConfig(db, "search.categories"),
    getSystemConfig(db, "search.time_range"),
    getSystemConfig(db, "search.safe_search"),
    getSystemConfig(db, "search.auth_token"),
  ]);

  const primaryUrl = primary?.trim() || envPrimaryUrl?.trim() || "";
  const fallbackUrl = fallback?.trim() || "";
  return {
    primaryUrl,
    ...(fallbackUrl ? { fallbackUrl } : {}),
    enabled: enabled !== "0",
    maxQueryChars: Math.max(100, Math.min(5000, Number(maxQuery) || 1000)),
    language: language?.trim() || "all",
    categories: categories?.trim() || "general",
    timeRange: timeRange?.trim() || "",
    safeSearch: Math.max(0, Math.min(2, Number(safeSearch) || 0)),
    ...(token?.trim() || envAuthToken?.trim() ? { authToken: token?.trim() || envAuthToken?.trim() } : {}),
  };
}

export async function searchViaGateway(
  config: SearchProviderConfig,
  query: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  if (!config.enabled) throw new Error("search_disabled");
  const urls = [config.primaryUrl, config.fallbackUrl].filter((value): value is string => Boolean(value));
  if (urls.length === 0) throw new Error("search_provider_unconfigured");

  let lastError: unknown = null;
  for (const baseUrl of urls) {
    try {
      const url = new URL("/search", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      url.searchParams.set("categories", config.categories);\n      if (config.language && config.language !== "all") url.searchParams.set("language", config.language);\n      if (config.timeRange) url.searchParams.set("time_range", config.timeRange);\n      url.searchParams.set("safesearch", String(config.safeSearch));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort("search_timeout"), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: "GET",
          headers: {
            accept: "application/json",
            ...(config.authToken ? { "x-veylora-search-token": config.authToken } : {}),
          },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`search_provider_http_${response.status}`);
        return await response.json();
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("search_provider_failed");
}
