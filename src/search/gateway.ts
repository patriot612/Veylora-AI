import { getSystemConfig } from "../config";

export type SearchProviderConfig = {
  primaryUrl: string;
  fallbackUrl?: string;
  enabled: boolean;
  maxQueryChars: number;
  authToken?: string;
};

export async function getSearchProviderConfig(
  db: D1Database,
  envPrimaryUrl?: string,
  envAuthToken?: string,
): Promise<SearchProviderConfig> {
  const [enabled, primary, fallback, maxQuery, token] = await Promise.all([
    getSystemConfig(db, "search.enabled"),
    getSystemConfig(db, "search.primary_url"),
    getSystemConfig(db, "search.fallback_url"),
    getSystemConfig(db, "search.max_query_chars"),
    getSystemConfig(db, "search.auth_token"),
  ]);

  const primaryUrl = primary?.trim() || envPrimaryUrl?.trim() || "";
  const fallbackUrl = fallback?.trim() || "";
  return {
    primaryUrl,
    ...(fallbackUrl ? { fallbackUrl } : {}),
    enabled: enabled !== "0",
    maxQueryChars: Math.max(100, Math.min(5000, Number(maxQuery) || 1000)),
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
      url.searchParams.set("categories", "general");
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
