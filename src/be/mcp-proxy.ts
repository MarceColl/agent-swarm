import { getMcpServerById, getResolvedConfig } from "@/be/db";
import { McpHttpClient, type McpTool, type McpToolCallEnvelope } from "@/mcp-client/http-client";
import { ensureMcpToken } from "@/oauth/ensure-mcp-token";
import { assertUrlSafe, publicEndpointSsrfOptions } from "@/oauth/mcp-wrapper";
import type { McpServer } from "@/types";
import { registerVolatileSecret } from "@/utils/secret-scrubber";

const MCP_PROXY_TIMEOUT_MS = 30_000;

type McpProxyContext = {
  agentId?: string;
  repoId?: string;
  timeoutMs?: number;
  /**
   * Per-call overrides of the server's stored (non-secret) headers, matched
   * case-insensitively. A string replaces the header; null drops it. Never
   * applies to `Authorization`.
   */
  headerOverrides?: Record<string, string | null>;
};

function applyHeaderOverrides(
  headers: Record<string, string>,
  overrides: Record<string, string | null> | undefined,
): Record<string, string> {
  if (!overrides) return headers;
  const result = { ...headers };
  for (const [name, value] of Object.entries(overrides)) {
    const lower = name.toLowerCase();
    if (lower === "authorization") continue;
    for (const key of Object.keys(result)) {
      if (key.toLowerCase() === lower) delete result[key];
    }
    if (value !== null) result[name] = value;
  }
  return result;
}

function parseHeadersJson(value: string | null): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([key, headerValue]) => [key, headerValue]),
    );
  } catch {
    return {};
  }
}

async function resolveHeaderConfigKeys(
  headerConfigKeys: string | null,
  context: { agentId?: string; repoId?: string },
): Promise<Record<string, string>> {
  if (!headerConfigKeys) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(headerConfigKeys);
  } catch {
    return {};
  }

  const configs = await getResolvedConfig(context.agentId, context.repoId);
  const configMap = new Map(configs.map((config) => [config.key, config.value]));
  const resolved: Record<string, string> = {};

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      const value = configMap.get(item);
      if (value === undefined) continue;
      registerVolatileSecret(value, `mcp-header:${item}`);
      resolved[item] = value;
    }
    return resolved;
  }

  if (!parsed || typeof parsed !== "object") return resolved;
  for (const [headerName, configKey] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof configKey !== "string") continue;
    const value = configMap.get(configKey);
    if (value === undefined) continue;
    registerVolatileSecret(value, `mcp-header:${configKey}`);
    resolved[headerName] = value;
  }
  return resolved;
}

async function resolveMcpHeaders(
  server: McpServer,
  context: { agentId?: string; repoId?: string },
): Promise<Record<string, string>> {
  const headers = {
    ...parseHeadersJson(server.headers),
    ...(await resolveHeaderConfigKeys(server.headerConfigKeys, context)),
  };

  if (server.authMethod !== "oauth") return headers;

  delete headers.Authorization;
  delete headers.authorization;
  const token = await ensureMcpToken(server.id);
  if (!token) throw new Error("No OAuth token for this MCP server");
  if (token.status !== "connected") {
    throw new Error(token.lastErrorMessage ?? `OAuth status: ${token.status}`);
  }

  registerVolatileSecret(token.accessToken, `mcp-oauth:${server.id}`);
  const rawType = token.tokenType || "Bearer";
  const prefix = rawType.toLowerCase() === "bearer" ? "Bearer" : rawType;
  headers.Authorization = `${prefix} ${token.accessToken}`;
  return headers;
}

async function createMcpServerClient(
  serverId: string,
  context: McpProxyContext = {},
): Promise<McpHttpClient> {
  const server = await getMcpServerById(serverId);
  if (!server) throw new Error("MCP server not found");
  if (!server.isEnabled) throw new Error("MCP server is disabled");
  if (server.transport === "sse") {
    throw new Error("SSE MCP servers are not supported yet — use a streamable HTTP server");
  }
  if (server.transport !== "http") {
    throw new Error("Only streamable HTTP MCP servers are supported by script connections");
  }
  if (!server.url) throw new Error("MCP server URL is required");

  // Validate when resolving the persisted URL, and again in McpHttpClient
  // immediately before every request to defend against a changed record or DNS
  // rebinding between the initial validation and an MCP tool call.
  assertUrlSafe(server.url, publicEndpointSsrfOptions());

  const client = new McpHttpClient(server.url, "", "", undefined, {
    clientInfo: { name: "agent-swarm-script-mcp-proxy", version: "1.0.0" },
    omitEmptyAuthHeaders: true,
    timeoutMs: context.timeoutMs ?? MCP_PROXY_TIMEOUT_MS,
    validateUrl: (url) => assertUrlSafe(url, publicEndpointSsrfOptions()),
  });
  client.useRawUrl = true;
  client.customHeaders = applyHeaderOverrides(
    await resolveMcpHeaders(server, context),
    context.headerOverrides,
  );
  return client;
}

export async function listMcpServerTools(
  serverId: string,
  context: McpProxyContext = {},
): Promise<McpTool[]> {
  const client = await createMcpServerClient(serverId, context);
  await client.initialize();
  return client.listTools();
}

export async function callMcpServerTool(
  serverId: string,
  tool: string,
  args: Record<string, unknown>,
  context: McpProxyContext = {},
): Promise<McpToolCallEnvelope> {
  const client = await createMcpServerClient(serverId, context);
  await client.initialize();
  return client.callToolRaw(tool, args);
}
