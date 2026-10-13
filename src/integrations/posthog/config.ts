/**
 * Native PostHog integration — shared constants for the guided setup routes.
 *
 * The integration is a plain global `mcp_servers` row named `posthog` that
 * points at PostHog's hosted MCP server and authenticates through the generic
 * MCP OAuth stack. Project/org pinning and read-only mode are non-secret
 * request headers stored on that row.
 */

export type PosthogRegion = "us" | "eu";

/** PostHog's hosted streamable-HTTP MCP endpoints, one per cloud region. */
export const POSTHOG_MCP_URLS: Record<PosthogRegion, string> = {
  us: "https://mcp.posthog.com/mcp",
  eu: "https://mcp-eu.posthog.com/mcp",
};

/** Well-known name of the global `mcp_servers` row the setup routes manage. */
export const POSTHOG_MCP_SERVER_NAME = "posthog";

export const POSTHOG_PROJECT_ID_HEADER = "x-posthog-project-id";
export const POSTHOG_ORGANIZATION_ID_HEADER = "x-posthog-organization-id";
export const POSTHOG_READ_ONLY_HEADER = "x-posthog-read-only";

/** Identity scopes kept alongside `*:read` when narrowing a read-only grant. */
const POSTHOG_IDENTITY_SCOPES = new Set(["openid", "profile", "email"]);

/** Narrow PostHog's advertised scopes to the read-only set (`*:read` + identity). */
export function posthogReadScopes(scopes: string[]): string[] {
  return scopes.filter((scope) => scope.endsWith(":read") || POSTHOG_IDENTITY_SCOPES.has(scope));
}

/** Build the non-secret request headers stored on the PostHog MCP row. */
export function buildPosthogHeaders(opts: {
  readOnly: boolean;
  projectId?: string | null;
  organizationId?: string | null;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  if (opts.readOnly) headers[POSTHOG_READ_ONLY_HEADER] = "true";
  if (opts.projectId) headers[POSTHOG_PROJECT_ID_HEADER] = opts.projectId;
  if (opts.organizationId) headers[POSTHOG_ORGANIZATION_ID_HEADER] = opts.organizationId;
  return headers;
}

/** MCP URL for a region, with an optional `?features=` tool filter. */
export function buildPosthogMcpUrl(region: PosthogRegion, features?: string[] | null): string {
  const base = POSTHOG_MCP_URLS[region];
  if (!features || features.length === 0) return base;
  return `${base}?features=${features.map(encodeURIComponent).join(",")}`;
}

/** Region of a stored PostHog MCP URL. Anything other than the EU host is US. */
export function posthogRegionFromUrl(url: string | null | undefined): PosthogRegion {
  if (!url) return "us";
  try {
    return new URL(url).hostname === new URL(POSTHOG_MCP_URLS.eu).hostname ? "eu" : "us";
  } catch {
    return "us";
  }
}

/** The `?features=` filter of a stored PostHog MCP URL, or null when unset. */
export function posthogFeaturesFromUrl(url: string | null | undefined): string[] | null {
  if (!url) return null;
  try {
    const raw = new URL(url).searchParams.get("features");
    if (!raw) return null;
    const features = raw
      .split(",")
      .map((feature) => feature.trim())
      .filter(Boolean);
    return features.length > 0 ? features : null;
  } catch {
    return null;
  }
}
