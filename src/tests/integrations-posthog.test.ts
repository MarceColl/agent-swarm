import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { closeDb, createAgent, getMcpServerByName, initDb, listMcpServers } from "../be/db";
import { getMcpOAuthToken, upsertMcpOAuthToken } from "../be/db-queries/mcp-oauth";
import { handleIntegrations } from "../http/integrations";
import { getPathSegments } from "../http/utils";
import {
  buildPosthogHeaders,
  buildPosthogMcpUrl,
  posthogFeaturesFromUrl,
  posthogReadScopes,
  posthogRegionFromUrl,
} from "../integrations/posthog/config";
import { listenOnFreePort } from "./test-net";

// ---------------------------------------------------------------------------
// Tests for the PostHog setup routes:
//   GET/PUT /api/integrations/posthog, GET /api/integrations/posthog/projects
// The PostHog MCP server is faked by stubbing globalThis.fetch; route calls go
// through the saved original fetch.
// ---------------------------------------------------------------------------

const TEST_DB_PATH = "./test-integrations-posthog.sqlite";
process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 21).toString("base64");

const LEAD_ID = crypto.randomUUID();
const WORKER_ID = crypto.randomUUID();
const AGENT_A = crypto.randomUUID();
const AGENT_B = crypto.randomUUID();

const originalFetch = globalThis.fetch;
let server: Server;
let baseUrl = "";

interface PosthogState {
  mcpServerId: string | null;
  region: "us" | "eu";
  readOnly: boolean;
  projectId: string | null;
  organizationId: string | null;
  features: string[] | null;
  oauthStatus: string;
  lastErrorMessage: string | null;
  installedAgentIds: string[];
}

async function api<T = unknown>(
  method: string,
  path: string,
  agentId: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: T }> {
  const res = await originalFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "X-Agent-ID": agentId,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function seedConnectedToken(mcpServerId: string): Promise<void> {
  await upsertMcpOAuthToken({
    mcpServerId,
    accessToken: "pha_testAccessToken1234567890abcdef",
    refreshToken: null,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    resourceUrl: "https://mcp.posthog.com",
    authorizationServerIssuer: "https://oauth.posthog.com",
    authorizeUrl: "https://oauth.posthog.com/oauth/authorize/",
    tokenUrl: "https://oauth.posthog.com/oauth/token/",
    clientSource: "dcr",
    status: "connected",
  });
}

beforeAll(async () => {
  initDb(TEST_DB_PATH);
  await createAgent({ id: LEAD_ID, name: "posthog-lead", isLead: true, status: "idle" });
  await createAgent({ id: WORKER_ID, name: "posthog-worker", isLead: false, status: "idle" });
  await createAgent({ id: AGENT_A, name: "posthog-a", isLead: false, status: "idle" });
  await createAgent({ id: AGENT_B, name: "posthog-b", isLead: false, status: "idle" });

  server = createHttpServer(async (req, res) => {
    const url = req.url || "";
    const handled = await handleIntegrations(
      req,
      res,
      getPathSegments(url),
      new URLSearchParams(url.split("?")[1] ?? ""),
    );
    if (!handled) {
      res.writeHead(404);
      res.end("not found");
    }
  });
  const port = await listenOnFreePort(server);
  baseUrl = `http://localhost:${port}`;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  server.close();
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
});

describe("PostHog config helpers", () => {
  test("buildPosthogHeaders sets read-only, project and org pins only when given", () => {
    expect(buildPosthogHeaders({ readOnly: false })).toEqual({});
    expect(buildPosthogHeaders({ readOnly: true, projectId: null, organizationId: null })).toEqual({
      "x-posthog-read-only": "true",
    });
    expect(
      buildPosthogHeaders({ readOnly: true, projectId: "123", organizationId: "org-1" }),
    ).toEqual({
      "x-posthog-read-only": "true",
      "x-posthog-project-id": "123",
      "x-posthog-organization-id": "org-1",
    });
  });

  test("posthogReadScopes keeps *:read and identity scopes", () => {
    expect(
      posthogReadScopes([
        "insight:read",
        "insight:write",
        "openid",
        "profile",
        "email",
        "introspection",
      ]),
    ).toEqual(["insight:read", "openid", "profile", "email"]);
  });

  test("URL helpers round-trip region and features", () => {
    expect(buildPosthogMcpUrl("us")).toBe("https://mcp.posthog.com/mcp");
    const eu = buildPosthogMcpUrl("eu", ["insights", "sql"]);
    expect(eu).toBe("https://mcp-eu.posthog.com/mcp?features=insights,sql");
    expect(posthogRegionFromUrl(eu)).toBe("eu");
    expect(posthogRegionFromUrl("https://mcp.posthog.com/mcp")).toBe("us");
    expect(posthogFeaturesFromUrl(eu)).toEqual(["insights", "sql"]);
    expect(posthogFeaturesFromUrl("https://mcp.posthog.com/mcp")).toBeNull();
  });
});

describe("PostHog setup routes", () => {
  test("GET returns defaults and projects is 409 before setup", async () => {
    const state = await api<PosthogState>("GET", "/api/integrations/posthog", LEAD_ID);
    expect(state.status).toBe(200);
    expect(state.body).toEqual({
      mcpServerId: null,
      region: "us",
      readOnly: true,
      projectId: null,
      organizationId: null,
      features: null,
      oauthStatus: "none",
      lastErrorMessage: null,
      installedAgentIds: [],
    });

    const projects = await api("GET", "/api/integrations/posthog/projects", LEAD_ID);
    expect(projects.status).toBe(409);
  });

  test("non-lead agents cannot create the row", async () => {
    const denied = await api("PUT", "/api/integrations/posthog", WORKER_ID, {
      region: "us",
      readOnly: true,
    });
    expect(denied.status).toBe(403);
    expect(await getMcpServerByName("posthog", "global", null)).toBeNull();
  });

  test("PUT creates the global row and a second PUT is idempotent", async () => {
    const first = await api<PosthogState>("PUT", "/api/integrations/posthog", LEAD_ID, {
      region: "us",
      readOnly: true,
      projectId: "12345",
    });
    expect(first.status).toBe(200);
    expect(first.body.mcpServerId).toBeTruthy();
    expect(first.body).toMatchObject({
      region: "us",
      readOnly: true,
      projectId: "12345",
      organizationId: null,
      oauthStatus: "none",
    });

    const row = await getMcpServerByName("posthog", "global", null);
    expect(row).toMatchObject({
      transport: "http",
      authMethod: "oauth",
      url: "https://mcp.posthog.com/mcp",
    });
    expect(JSON.parse(row!.headers!)).toEqual({
      "x-posthog-read-only": "true",
      "x-posthog-project-id": "12345",
    });

    const second = await api<PosthogState>("PUT", "/api/integrations/posthog", LEAD_ID, {
      region: "us",
      readOnly: true,
    });
    expect(second.status).toBe(200);
    expect(second.body.mcpServerId).toBe(first.body.mcpServerId);
    // Omitted projectId keeps the stored pin.
    expect(second.body.projectId).toBe("12345");
    expect(
      (await listMcpServers({ search: "posthog" })).filter((s) => s.name === "posthog"),
    ).toHaveLength(1);
    const again = await getMcpServerByName("posthog", "global", null);
    expect(again?.version).toBe(row?.version);

    const cleared = await api<PosthogState>("PUT", "/api/integrations/posthog", LEAD_ID, {
      region: "us",
      readOnly: false,
      projectId: null,
      features: ["insights", "sql"],
    });
    expect(cleared.body).toMatchObject({
      readOnly: false,
      projectId: null,
      features: ["insights", "sql"],
    });
    expect((await getMcpServerByName("posthog", "global", null))?.url).toBe(
      "https://mcp.posthog.com/mcp?features=insights,sql",
    );
  });

  test("non-lead agents cannot update the row or list projects", async () => {
    const denied = await api("PUT", "/api/integrations/posthog", WORKER_ID, {
      region: "eu",
      readOnly: true,
    });
    expect(denied.status).toBe(403);
    expect(posthogRegionFromUrl((await getMcpServerByName("posthog", "global", null))?.url)).toBe(
      "us",
    );

    const projects = await api("GET", "/api/integrations/posthog/projects", WORKER_ID);
    expect(projects.status).toBe(403);
  });

  test("agentIds diffs installs and omitted agentIds leaves them alone", async () => {
    const both = await api<PosthogState>("PUT", "/api/integrations/posthog", LEAD_ID, {
      region: "us",
      readOnly: true,
      agentIds: [AGENT_A, AGENT_B],
    });
    expect(both.status).toBe(200);
    expect(both.body.installedAgentIds).toEqual([AGENT_A, AGENT_B].sort());

    const onlyB = await api<PosthogState>("PUT", "/api/integrations/posthog", LEAD_ID, {
      region: "us",
      readOnly: true,
      agentIds: [AGENT_B],
    });
    expect(onlyB.body.installedAgentIds).toEqual([AGENT_B]);

    const untouched = await api<PosthogState>("PUT", "/api/integrations/posthog", LEAD_ID, {
      region: "us",
      readOnly: true,
    });
    expect(untouched.body.installedAgentIds).toEqual([AGENT_B]);

    const unknown = await api("PUT", "/api/integrations/posthog", LEAD_ID, {
      region: "us",
      readOnly: true,
      agentIds: [AGENT_B, crypto.randomUUID()],
    });
    expect(unknown.status).toBe(400);
    const state = await api<PosthogState>("GET", "/api/integrations/posthog", LEAD_ID);
    expect(state.body.installedAgentIds).toEqual([AGENT_B]);
  });

  test("projects is 409 while the row exists but is not connected", async () => {
    const projects = await api<{ error: string }>(
      "GET",
      "/api/integrations/posthog/projects",
      LEAD_ID,
    );
    expect(projects.status).toBe(409);
    expect(projects.body.error).toContain("not connected");
  });

  test("projects lists each org with the org pinned and the project pin dropped", async () => {
    await api("PUT", "/api/integrations/posthog", LEAD_ID, {
      region: "us",
      readOnly: true,
      projectId: "999",
      organizationId: "org-pinned",
    });
    const row = await getMcpServerByName("posthog", "global", null);
    await seedConnectedToken(row!.id);

    const toolCalls: Array<{ name: string; headers: Headers }> = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const rpc = JSON.parse(String(init?.body)) as {
        id?: number;
        method: string;
        params?: { name?: string };
      };
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (rpc.method === "initialize")
        return Response.json({ jsonrpc: "2.0", id: rpc.id, result: {} });

      const name = rpc.params?.name ?? "";
      toolCalls.push({ name, headers });
      if (name === "organizations-get") {
        const orgs = [
          { id: "org-1", name: "Acme", slug: "acme", membership_level: 15 },
          { id: "org-2", name: "Beta", slug: "beta", membership_level: 1 },
        ];
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { content: [{ type: "text", text: JSON.stringify(orgs) }] },
        });
      }
      const org = headers.get("x-posthog-organization-id");
      const result =
        org === "org-1"
          ? {
              content: [{ type: "text", text: "see structured" }],
              structuredContent: {
                results: [
                  { id: 1, name: "Web" },
                  { id: 2, name: "App" },
                ],
              },
            }
          : { content: [{ type: "text", text: JSON.stringify([{ id: 3, name: "Beta site" }]) }] };
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
    }) as typeof fetch;

    const res = await api<{ organizations: unknown }>(
      "GET",
      "/api/integrations/posthog/projects",
      LEAD_ID,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      organizations: [
        {
          id: "org-1",
          name: "Acme",
          projects: [
            { id: "1", name: "Web" },
            { id: "2", name: "App" },
          ],
        },
        { id: "org-2", name: "Beta", projects: [{ id: "3", name: "Beta site" }] },
      ],
    });

    expect(toolCalls.map((call) => call.name)).toEqual([
      "organizations-get",
      "projects-get",
      "projects-get",
    ]);
    for (const call of toolCalls) {
      expect(call.headers.get("authorization")).toBe("Bearer pha_testAccessToken1234567890abcdef");
      expect(call.headers.get("x-posthog-read-only")).toBe("true");
    }
    // organizations-get keeps the stored pins; projects-get overrides them.
    expect(toolCalls[0]!.headers.get("x-posthog-project-id")).toBe("999");
    expect(toolCalls[1]!.headers.get("x-posthog-organization-id")).toBe("org-1");
    expect(toolCalls[1]!.headers.get("x-posthog-project-id")).toBeNull();
    expect(toolCalls[2]!.headers.get("x-posthog-organization-id")).toBe("org-2");
  });

  test("a tool error surfaces as 502 without leaking the token", async () => {
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const rpc = JSON.parse(String(init?.body)) as { id?: number; method: string };
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (rpc.method === "initialize")
        return Response.json({ jsonrpc: "2.0", id: rpc.id, result: {} });
      return Response.json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          isError: true,
          content: [{ type: "text", text: "bad token pha_testAccessToken1234567890abcdef" }],
        },
      });
    }) as typeof fetch;

    const res = await api<{ error: string }>("GET", "/api/integrations/posthog/projects", LEAD_ID);
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("organizations-get failed");
    expect(res.body.error).not.toContain("pha_testAccessToken");
  });

  test("a region switch updates the URL and clears the stored authorization", async () => {
    const before = await api<PosthogState>("GET", "/api/integrations/posthog", LEAD_ID);
    expect(before.body.oauthStatus).toBe("connected");

    const switched = await api<PosthogState>("PUT", "/api/integrations/posthog", LEAD_ID, {
      region: "eu",
      readOnly: true,
    });
    expect(switched.status).toBe(200);
    expect(switched.body.region).toBe("eu");
    expect(switched.body.oauthStatus).not.toBe("connected");

    const row = await getMcpServerByName("posthog", "global", null);
    // The stored features filter follows the region switch.
    expect(row?.url).toBe("https://mcp-eu.posthog.com/mcp?features=insights,sql");
    expect(row?.authMethod).toBe("oauth");
    const token = await getMcpOAuthToken(row!.id);
    expect(token?.status ?? "none").not.toBe("connected");
    expect(token?.accessToken ?? "").toBe("");

    const projects = await api("GET", "/api/integrations/posthog/projects", LEAD_ID);
    expect(projects.status).toBe(409);
  });
});
