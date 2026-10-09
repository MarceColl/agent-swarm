import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getConfig } from "@/lib/config";

// ---------------------------------------------------------------------------
// PostHog integration hooks
//
// Wrap the guided-setup routes in `src/http/integrations.ts`:
//   GET  /api/integrations/posthog           -> PosthogIntegration
//   PUT  /api/integrations/posthog           -> PosthogIntegration
//   GET  /api/integrations/posthog/projects  -> { organizations }
//
// The integration is one global `mcp_servers` row. OAuth goes through the
// generic MCP OAuth hooks (`use-mcp-oauth.ts`) with the returned `mcpServerId`.
// ---------------------------------------------------------------------------

export type PosthogRegion = "us" | "eu";

/** `none` = no stored authorization; the rest mirror the MCP OAuth token status. */
export type PosthogOAuthStatus = "none" | "connected" | "expired" | "error" | "revoked";

export interface PosthogIntegration {
  mcpServerId: string | null;
  region: PosthogRegion;
  readOnly: boolean;
  projectId: string | null;
  organizationId: string | null;
  features: string[] | null;
  oauthStatus: PosthogOAuthStatus;
  lastErrorMessage: string | null;
  installedAgentIds: string[];
}

/** Omitted optional fields keep their stored value; `null` clears it. */
export interface PosthogIntegrationUpdate {
  region: PosthogRegion;
  readOnly: boolean;
  projectId?: string | null;
  organizationId?: string | null;
  features?: string[] | null;
  agentIds?: string[];
}

export interface PosthogProject {
  id: string;
  name: string;
}

export interface PosthogOrganization {
  id: string;
  name: string;
  projects: PosthogProject[];
}

export const POSTHOG_INTEGRATION_QUERY_KEY = ["integrations", "posthog"] as const;
const POSTHOG_PROJECTS_QUERY_KEY = ["integrations", "posthog", "projects"] as const;

function getBaseUrl(): string {
  const config = getConfig();
  if (import.meta.env.DEV && config.apiUrl === "http://localhost:3013") {
    return "";
  }
  return config.apiUrl;
}

function getHeaders(): HeadersInit {
  const config = getConfig();
  const headers: HeadersInit = { "Content-Type": "application/json" };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  return headers;
}

async function readJson<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `${label} (${res.status})`);
  }
  return (await res.json()) as T;
}

async function fetchPosthogIntegration(): Promise<PosthogIntegration> {
  const res = await fetch(`${getBaseUrl()}/api/integrations/posthog`, { headers: getHeaders() });
  return readJson<PosthogIntegration>(res, "Failed to load PostHog integration");
}

async function savePosthogIntegration(body: PosthogIntegrationUpdate): Promise<PosthogIntegration> {
  const res = await fetch(`${getBaseUrl()}/api/integrations/posthog`, {
    method: "PUT",
    headers: getHeaders(),
    body: JSON.stringify(body),
  });
  return readJson<PosthogIntegration>(res, "Failed to save PostHog integration");
}

async function fetchPosthogProjects(): Promise<PosthogOrganization[]> {
  const res = await fetch(`${getBaseUrl()}/api/integrations/posthog/projects`, {
    headers: getHeaders(),
  });
  const data = await readJson<{ organizations: PosthogOrganization[] }>(
    res,
    "Failed to load PostHog projects",
  );
  return data.organizations;
}

export function usePosthogIntegration() {
  return useQuery({
    queryKey: POSTHOG_INTEGRATION_QUERY_KEY,
    queryFn: fetchPosthogIntegration,
    // The connection changes through an OAuth redirect; no need to poll.
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

export function useSavePosthogIntegration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: savePosthogIntegration,
    onMutate: async () => {
      // A GET that started before the write must not overwrite its result.
      await qc.cancelQueries({ queryKey: POSTHOG_INTEGRATION_QUERY_KEY, exact: true });
    },
    onSuccess: (data) => {
      qc.setQueryData(POSTHOG_INTEGRATION_QUERY_KEY, data);
      // A region change drops the token; installs and the row show on other pages.
      void qc.invalidateQueries({ queryKey: POSTHOG_PROJECTS_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: ["mcp-servers"] });
      void qc.invalidateQueries({ queryKey: ["agent-mcp-servers"] });
      if (data.mcpServerId) {
        void qc.invalidateQueries({ queryKey: ["mcp-server", data.mcpServerId] });
        void qc.invalidateQueries({ queryKey: ["mcp-oauth-status", data.mcpServerId] });
      }
    },
  });
}

/** Organizations and projects of the connected account. Enable only once connected. */
export function usePosthogProjects(enabled: boolean) {
  return useQuery({
    queryKey: POSTHOG_PROJECTS_QUERY_KEY,
    queryFn: fetchPosthogProjects,
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}
