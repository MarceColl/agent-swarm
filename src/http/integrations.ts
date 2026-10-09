import type { IncomingMessage, ServerResponse } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  createMcpServer,
  emitMcpServerConnectedTelemetry,
  getAgentById,
  getDbClient,
  getMcpServerByName,
  getMcpServerInstalledAgentIds,
  installMcpServer,
  uninstallMcpServer,
  updateMcpServer,
} from "../be/db";
import {
  deleteMcpOAuthToken,
  getMcpOAuthToken,
  type McpOAuthToken,
} from "../be/db-queries/mcp-oauth";
import { callMcpServerTool } from "../be/mcp-proxy";
import {
  buildPosthogHeaders,
  buildPosthogMcpUrl,
  POSTHOG_MCP_SERVER_NAME,
  POSTHOG_ORGANIZATION_ID_HEADER,
  POSTHOG_PROJECT_ID_HEADER,
  POSTHOG_READ_ONLY_HEADER,
  posthogFeaturesFromUrl,
  posthogRegionFromUrl,
} from "../integrations/posthog/config";
import type { McpToolCallEnvelope } from "../mcp-client/http-client";
import { buildSlackManifest } from "../slack/manifest";
import type { McpServer } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import { resolveConfigValue, resolveMcpBaseUrl } from "./config-values";
import { revokeMcpOAuthTokenBestEffort } from "./mcp-oauth";
import { mcpServerPermissionRefusal } from "./mcp-servers";
import { route } from "./route-def";
import { jsonError } from "./utils";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Minimal `client.beta.agents.retrieve` shape we depend on. Lets tests inject
 * a fake without pulling the entire SDK surface in.
 */
export interface ClaudeManagedTestClient {
  beta: {
    agents: {
      retrieve: (agentId: string) => Promise<{ name?: string | null; model?: string | null }>;
    };
  };
}

interface TestConnectionDeps {
  /**
   * Optional injectable client factory. When omitted, a real `Anthropic` SDK
   * client is constructed with the resolved API key.
   */
  buildClient?: (apiKey: string) => ClaudeManagedTestClient;
}

// ─── Response schemas ────────────────────────────────────────────────────────

const ClaudeManagedTestResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    agentName: z.string().nullable(),
    model: z.string().nullable(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
  }),
]);

const McpUserConfigSchema = z.object({
  mcpBaseUrl: z.string(),
  mcpUserUrl: z.string(),
});

const SlackManifestSchema = z.record(z.string(), z.unknown());

const PosthogIntegrationSchema = z.object({
  mcpServerId: z.string().nullable(),
  region: z.enum(["us", "eu"]),
  readOnly: z.boolean(),
  projectId: z.string().nullable(),
  organizationId: z.string().nullable(),
  features: z.array(z.string()).nullable(),
  /** `none` = no stored authorization; the rest mirror the MCP OAuth token status. */
  oauthStatus: z.enum(["none", "connected", "expired", "error", "revoked"]),
  lastErrorMessage: z.string().nullable(),
  installedAgentIds: z.array(z.string()),
});

/** PostHog ids end up in request headers, so keep them to a safe charset. */
const PosthogIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/, "must be 1-128 letters, digits, '_' or '-'");

const PosthogIntegrationUpdateSchema = z.object({
  region: z.enum(["us", "eu"]),
  readOnly: z.boolean(),
  projectId: PosthogIdSchema.nullable().optional(),
  organizationId: PosthogIdSchema.nullable().optional(),
  features: z.array(PosthogIdSchema).nullable().optional(),
  agentIds: z.array(z.string().min(1)).optional(),
});

const PosthogProjectsSchema = z.object({
  organizations: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      projects: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  ),
});

// ─── Route Definition ────────────────────────────────────────────────────────

const claudeManagedTestRoute = route({
  method: "post",
  path: "/api/integrations/claude-managed/test",
  pattern: ["api", "integrations", "claude-managed", "test"],
  summary:
    "Test the claude-managed integration: resolves ANTHROPIC_API_KEY + MANAGED_AGENT_ID from swarm_config and calls beta.agents.retrieve.",
  tags: ["Integrations"],
  body: z.object({}).optional(),
  responses: {
    200: {
      description:
        "Connection result — `{ ok: true, agentName, model }` on success or `{ ok: false, error }` on any failure (missing config, Anthropic API error). Always 200 OK.",
      schema: ClaudeManagedTestResultSchema,
    },
  },
});

const mcpUserConfigRoute = route({
  method: "get",
  path: "/api/integrations/mcp-user/config",
  pattern: ["api", "integrations", "mcp-user", "config"],
  summary: "Get server-derived config for end-user MCP clients.",
  tags: ["Integrations"],
  responses: {
    200: {
      description:
        "Server-derived MCP user config. `mcpBaseUrl` is the API server base URL and `mcpUserUrl` appends `/mcp-user`.",
      schema: McpUserConfigSchema,
    },
  },
});

const slackManifestRoute = route({
  method: "get",
  path: "/api/integrations/slack/manifest",
  pattern: ["api", "integrations", "slack", "manifest"],
  summary: "Build a Slack app manifest for this swarm",
  tags: ["Integrations"],
  query: z.object({ name: z.string().optional() }),
  responses: {
    200: { description: "Slack app manifest", schema: SlackManifestSchema },
  },
});

const posthogGetRoute = route({
  method: "get",
  path: "/api/integrations/posthog",
  pattern: ["api", "integrations", "posthog"],
  summary: "Get the PostHog integration state (MCP row, pinning, OAuth status, installs).",
  tags: ["Integrations"],
  responses: {
    200: {
      description:
        "PostHog integration state. Defaults (`mcpServerId: null`, region `us`, read-only, `oauthStatus: none`) when it is not set up.",
      schema: PosthogIntegrationSchema,
    },
  },
});

const posthogPutRoute = route({
  method: "put",
  path: "/api/integrations/posthog",
  pattern: ["api", "integrations", "posthog"],
  summary:
    "Create or update the global PostHog MCP server (region, read-only, pinned project/org, features) and diff its agent installs.",
  tags: ["Integrations"],
  body: PosthogIntegrationUpdateSchema,
  responses: {
    200: { description: "Updated PostHog integration state", schema: PosthogIntegrationSchema },
    400: { description: "Validation error or unknown agent" },
    403: { description: "Missing MCP server create/update/install permission" },
  },
  rbac: { permission: "mcp-server.update.any" },
});

const posthogProjectsRoute = route({
  method: "get",
  path: "/api/integrations/posthog/projects",
  pattern: ["api", "integrations", "posthog", "projects"],
  summary: "List the PostHog organizations and projects the connected account can access.",
  tags: ["Integrations"],
  responses: {
    200: { description: "Organizations with their projects", schema: PosthogProjectsSchema },
    403: { description: "Missing MCP server update permission" },
    409: { description: "PostHog is not set up or not connected" },
    502: { description: "PostHog MCP call failed" },
  },
  rbac: { permission: "mcp-server.update.any" },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Upper bound on organizations listed, so one request makes at most N+1 MCP calls. */
const POSTHOG_MAX_ORGANIZATIONS = 20;

type PosthogIntegrationState = z.infer<typeof PosthogIntegrationSchema>;

/** Stored non-secret headers of an MCP row, with lowercased names. */
function storedHeaders(server: McpServer): Record<string, string> {
  if (!server.headers) return {};
  try {
    const parsed = JSON.parse(server.headers) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([name, value]) => [name.toLowerCase(), value]),
    );
  } catch {
    return {};
  }
}

async function posthogIntegrationState(server: McpServer | null): Promise<PosthogIntegrationState> {
  if (!server) {
    return {
      mcpServerId: null,
      region: "us",
      readOnly: true,
      projectId: null,
      organizationId: null,
      features: null,
      oauthStatus: "none",
      lastErrorMessage: null,
      installedAgentIds: [],
    };
  }
  const headers = storedHeaders(server);
  const token = await getMcpOAuthToken(server.id);
  return {
    mcpServerId: server.id,
    region: posthogRegionFromUrl(server.url),
    readOnly: headers[POSTHOG_READ_ONLY_HEADER] === "true",
    projectId: headers[POSTHOG_PROJECT_ID_HEADER] ?? null,
    organizationId: headers[POSTHOG_ORGANIZATION_ID_HEADER] ?? null,
    features: posthogFeaturesFromUrl(server.url),
    oauthStatus: token?.status ?? "none",
    lastErrorMessage: token?.lastErrorMessage ?? null,
    installedAgentIds: await getMcpServerInstalledAgentIds(server.id),
  };
}

function urlOrigin(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Records from a PostHog MCP tool result. Reads `structuredContent` when
 * present, else the first text block that parses as JSON, and unwraps a
 * `{ results: [...] }`-style envelope. Throws on a tool error or no JSON.
 */
function posthogToolRecords(
  tool: string,
  envelope: McpToolCallEnvelope,
): Record<string, unknown>[] {
  if (!envelope.ok) {
    const error = envelope.error;
    throw new Error(
      `${tool} failed: ${typeof error === "string" ? error : (error.message ?? "unknown error")}`,
    );
  }
  const texts = envelope.result.content
    .map((block) => block.text)
    .filter((text): text is string => typeof text === "string");
  if (envelope.result.isError) {
    throw new Error(`${tool} failed: ${texts.join(" ") || "tool returned an error"}`);
  }

  let payload: unknown = envelope.result.structuredContent;
  if (payload === undefined) {
    for (const text of texts) {
      try {
        payload = JSON.parse(text);
        break;
      } catch {
        // Not JSON; try the next text block.
      }
    }
  }
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (isRecord(payload)) {
    for (const key of ["results", "data", "items", "organizations", "projects"]) {
      const value = payload[key];
      if (Array.isArray(value)) return value.filter(isRecord);
    }
  }
  throw new Error(`${tool} returned an unexpected response`);
}

function posthogIdName(record: Record<string, unknown>): { id: string; name: string } | null {
  const id = record.id;
  if (typeof id !== "string" && typeof id !== "number") return null;
  const name = typeof record.name === "string" && record.name ? record.name : String(id);
  return { id: String(id), name };
}

async function listPosthogOrganizations(
  mcpServerId: string,
): Promise<z.infer<typeof PosthogProjectsSchema>["organizations"]> {
  const orgs = posthogToolRecords(
    "organizations-get",
    await callMcpServerTool(mcpServerId, "organizations-get", {}),
  )
    .map(posthogIdName)
    .filter((org): org is { id: string; name: string } => org !== null)
    .slice(0, POSTHOG_MAX_ORGANIZATIONS);

  const organizations: z.infer<typeof PosthogProjectsSchema>["organizations"] = [];
  for (const org of orgs) {
    // projects-get lists the resolved org's projects: pin this org and drop any
    // pinned project, which would otherwise decide the org.
    const envelope = await callMcpServerTool(
      mcpServerId,
      "projects-get",
      {},
      {
        headerOverrides: {
          [POSTHOG_ORGANIZATION_ID_HEADER]: org.id,
          [POSTHOG_PROJECT_ID_HEADER]: null,
        },
      },
    );
    const projects = posthogToolRecords("projects-get", envelope)
      .map(posthogIdName)
      .filter((project): project is { id: string; name: string } => project !== null);
    organizations.push({ ...org, projects });
  }
  return organizations;
}

// ─── Public handler factory ──────────────────────────────────────────────────

/**
 * Build the integrations handler. Exposed as a factory so tests can inject a
 * fake Anthropic client.
 */
export function createIntegrationsHandler(deps: TestConnectionDeps = {}) {
  const buildClient =
    deps.buildClient ??
    ((apiKey: string) => new Anthropic({ apiKey }) as unknown as ClaudeManagedTestClient);

  return async function handleIntegrations(
    req: IncomingMessage,
    res: ServerResponse,
    pathSegments: string[],
    queryParams = new URLSearchParams(),
  ): Promise<boolean> {
    if (slackManifestRoute.match(req.method, pathSegments)) {
      const parsed = await slackManifestRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      slackManifestRoute.respond(res, 200, buildSlackManifest(parsed.query.name));
      return true;
    }

    if (mcpUserConfigRoute.match(req.method, pathSegments)) {
      const mcpBaseUrl = await resolveMcpBaseUrl();
      mcpUserConfigRoute.respond(res, 200, { mcpBaseUrl, mcpUserUrl: `${mcpBaseUrl}/mcp-user` });
      return true;
    }

    if (posthogGetRoute.match(req.method, pathSegments)) {
      const server = await getMcpServerByName(POSTHOG_MCP_SERVER_NAME, "global", null);
      posthogGetRoute.respond(res, 200, await posthogIntegrationState(server));
      return true;
    }

    if (posthogPutRoute.match(req.method, pathSegments)) {
      const parsed = await posthogPutRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      const body = parsed.body;

      const outcome = await getDbClient().transaction(async () => {
        const existing = await getMcpServerByName(POSTHOG_MCP_SERVER_NAME, "global", null);
        const refusal = existing
          ? await mcpServerPermissionRefusal(req, "mcp-server.update.any", {
              kind: "owned",
              ownerAgentId: existing.ownerAgentId,
            })
          : await mcpServerPermissionRefusal(req, "mcp-server.create.swarm", { kind: "none" });
        if (refusal) return { kind: "refused", status: 403, message: refusal } as const;

        const installed = existing ? await getMcpServerInstalledAgentIds(existing.id) : [];
        const wanted = body.agentIds ? new Set(body.agentIds) : null;
        const toInstall = wanted ? [...wanted].filter((id) => !installed.includes(id)) : [];
        const toUninstall = wanted ? installed.filter((id) => !wanted.has(id)) : [];
        for (const [verb, ids] of [
          ["mcp-server.install.any", toInstall],
          ["mcp-server.uninstall.any", toUninstall],
        ] as const) {
          if (ids.length === 0) continue;
          const installRefusal = await mcpServerPermissionRefusal(req, verb, { kind: "none" });
          if (installRefusal) {
            return { kind: "refused", status: 403, message: installRefusal } as const;
          }
        }
        for (const agentId of toInstall) {
          if (!(await getAgentById(agentId))) {
            return {
              kind: "refused",
              status: 400,
              message: `Agent not found: ${agentId}`,
            } as const;
          }
        }

        // Omitted optional fields keep their stored value; null clears it.
        const current = existing ? storedHeaders(existing) : {};
        const features =
          body.features !== undefined ? body.features : posthogFeaturesFromUrl(existing?.url);
        const url = buildPosthogMcpUrl(body.region, features);
        const headers = JSON.stringify(
          buildPosthogHeaders({
            readOnly: body.readOnly,
            projectId:
              body.projectId !== undefined ? body.projectId : current[POSTHOG_PROJECT_ID_HEADER],
            organizationId:
              body.organizationId !== undefined
                ? body.organizationId
                : current[POSTHOG_ORGANIZATION_ID_HEADER],
          }),
        );

        let server: McpServer | null;
        // The stored token was issued for the old resource; it must not follow the URL.
        let clearedToken: McpOAuthToken | null = null;
        if (existing) {
          server = await updateMcpServer(existing.id, {
            transport: existing.transport !== "http" ? "http" : undefined,
            url: existing.url !== url ? url : undefined,
            headers: existing.headers !== headers ? headers : undefined,
            authMethod: existing.authMethod !== "oauth" ? "oauth" : undefined,
          });
          if (urlOrigin(existing.url) !== urlOrigin(url)) {
            clearedToken = await getMcpOAuthToken(existing.id);
            if (clearedToken) await deleteMcpOAuthToken(existing.id);
          }
        } else {
          const created = await createMcpServer({
            name: POSTHOG_MCP_SERVER_NAME,
            description: "PostHog MCP server, managed from the Integrations page.",
            scope: "global",
            transport: "http",
            url,
            headers,
          });
          server = await updateMcpServer(created.id, { authMethod: "oauth" });
        }
        if (!server) throw new Error("PostHog MCP server disappeared during update");

        for (const agentId of toInstall) await installMcpServer(agentId, server.id);
        for (const agentId of toUninstall) await uninstallMcpServer(agentId, server.id);
        return { kind: "ok", server, created: !existing, clearedToken } as const;
      });

      if (outcome.kind === "refused") {
        jsonError(res, outcome.message, outcome.status);
        return true;
      }
      if (outcome.clearedToken) await revokeMcpOAuthTokenBestEffort(outcome.clearedToken);
      if (outcome.created) await emitMcpServerConnectedTelemetry();
      posthogPutRoute.respond(res, 200, await posthogIntegrationState(outcome.server));
      return true;
    }

    if (posthogProjectsRoute.match(req.method, pathSegments)) {
      const server = await getMcpServerByName(POSTHOG_MCP_SERVER_NAME, "global", null);
      const refusal = await mcpServerPermissionRefusal(req, "mcp-server.update.any", {
        kind: "owned",
        ownerAgentId: server?.ownerAgentId ?? null,
      });
      if (refusal) {
        jsonError(res, refusal, 403);
        return true;
      }
      if (!server) {
        jsonError(res, "PostHog is not set up", 409);
        return true;
      }
      const token = await getMcpOAuthToken(server.id);
      if (token?.status !== "connected") {
        jsonError(res, "PostHog is not connected", 409);
        return true;
      }

      try {
        const organizations = await listPosthogOrganizations(server.id);
        posthogProjectsRoute.respond(res, 200, { organizations });
      } catch (err) {
        jsonError(res, scrubSecrets(err instanceof Error ? err.message : String(err)), 502);
      }
      return true;
    }

    if (claudeManagedTestRoute.match(req.method, pathSegments)) {
      const apiKey = await resolveConfigValue("ANTHROPIC_API_KEY");
      const agentId = await resolveConfigValue("MANAGED_AGENT_ID");

      if (!apiKey || !agentId) {
        const missing: string[] = [];
        if (!apiKey) missing.push("ANTHROPIC_API_KEY");
        if (!agentId) missing.push("MANAGED_AGENT_ID");
        claudeManagedTestRoute.respond(res, 200, {
          ok: false,
          error: `Missing required config: ${missing.join(", ")}. Run \`bun run src/cli.tsx claude-managed-setup\` to populate.`,
        });
        return true;
      }

      try {
        const client = buildClient(apiKey);
        const agent = await client.beta.agents.retrieve(agentId);
        // `agent.model` is `BetaManagedAgentsModelConfig` ({id, speed}). Flatten
        // to a string so the UI can render it directly without type guards.
        const modelId =
          typeof agent.model === "string"
            ? agent.model
            : ((agent.model as { id?: string } | null | undefined)?.id ?? null);
        claudeManagedTestRoute.respond(res, 200, {
          ok: true,
          agentName: agent.name ?? null,
          model: modelId,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        claudeManagedTestRoute.respond(res, 200, { ok: false, error: message });
      }
      return true;
    }

    return false;
  };
}

// ─── Default singleton (used in production / OpenAPI generation) ─────────────

export const handleIntegrations = createIntegrationsHandler();
