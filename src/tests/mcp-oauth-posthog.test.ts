import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { closeDb, createMcpServer, initDb } from "../be/db";
import { getMcpOAuthToken } from "../be/db-queries/mcp-oauth";
import { handleCore } from "../http/core";
import { handleMcpOAuth } from "../http/mcp-oauth";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { ensureMcpToken } from "../oauth/ensure-mcp-token";

// Regression coverage for PostHog's hosted MCP server (mcp.posthog.com, AS
// oauth.posthog.com) on the generic MCP OAuth stack. Two local Bun.serve
// instances replay trimmed copies of PostHog's live metadata (captured
// 2026-10-09) with the hosts rewritten to loopback: one plays the MCP host,
// one the authorization server. Paths, trailing slashes, auth methods and
// the PRM `resource` shapes are kept as PostHog serves them. Uses the same
// dispatch() harness as mcp-oauth-dcr-reuse.test.ts.

const API_KEY = "example-test-secret-key";
const TEST_DB_PATH = "./test-mcp-oauth-posthog.sqlite";

// Live PRM advertises 156 scopes (82 `*:read`); this is a representative
// subset. The AS advertises a superset (226) — the PRM list is what we request.
const POSTHOG_SCOPES = [
  "openid",
  "profile",
  "email",
  "introspection",
  "action:read",
  "dashboard:read",
  "dashboard:write",
  "error_tracking:read",
  "experiment:read",
  "feature_flag:read",
  "feature_flag:write",
  "insight:read",
  "insight:write",
  "organization:read",
  "project:read",
  "query:read",
  "user:read",
];

const READ_ONLY_SCOPES = "openid profile email insight:read query:read project:read";

const ACCESS_TOKEN = "pha_test_access_0000000000000000";
const REFRESHED_ACCESS_TOKEN = "pha_test_access_1111111111111111";
const REFRESH_TOKEN = "phr_test_refresh_000000000000000";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
}

type TestResponse = {
  status: number;
  text: string;
  headers: Record<string, string>;
  json: () => Promise<unknown>;
};

async function dispatch(path: string, init: RequestInit = {}): Promise<TestResponse> {
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.body !== undefined && !headers["Content-Type"])
    headers["Content-Type"] = "application/json";

  const req = Readable.from(init.body ? [Buffer.from(String(init.body))] : []) as IncomingMessage;
  req.method = init.method ?? "GET";
  req.url = path;
  req.headers = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );

  let status = 200;
  let text = "";
  const responseHeaders: Record<string, string> = {};
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader(name: string, value: number | string | readonly string[]) {
      responseHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
      return this;
    },
    writeHead(code: number, headersArg?: Record<string, number | string | readonly string[]>) {
      status = code;
      if (headersArg) {
        for (const [key, value] of Object.entries(headersArg)) {
          responseHeaders[key.toLowerCase()] = Array.isArray(value)
            ? value.join(", ")
            : String(value);
        }
      }
      this.headersSent = true;
      return this;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) text += String(chunk);
      this.writableEnded = true;
      return this;
    },
  } as unknown as ServerResponse;

  const handledCore = await handleCore(req, res, undefined, API_KEY);
  if (!handledCore) {
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const handled = await handleMcpOAuth(req, res, pathSegments, queryParams);
    if (!handled) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  }

  return {
    status,
    text,
    headers: responseHeaders,
    json: async () => JSON.parse(text),
  };
}

type RecordedRequest = {
  host: "mcp" | "as";
  method: string;
  path: string;
  headers: Headers;
  body: string;
};

describe("MCP OAuth against PostHog-shaped metadata", () => {
  let mcpHost: ReturnType<typeof Bun.serve>;
  let asHost: ReturnType<typeof Bun.serve>;
  let mcpOrigin = "";
  let asOrigin = "";
  let mcpUrl = "";

  let requests: RecordedRequest[] = [];
  let dcrCallCount = 0;
  // PostHog serves the root PRM today; flip off to exercise the
  // WWW-Authenticate → path-suffixed PRM fallback.
  let rootPrmAvailable = true;

  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "SECRETS_ENCRYPTION_KEY",
    "MCP_OAUTH_ALLOW_PRIVATE_HOSTS",
    "PUBLIC_MCP_BASE_URL",
    "APP_URL",
  ];

  function prm(resource: string) {
    return {
      resource,
      authorization_servers: [asOrigin],
      scopes_supported: POSTHOG_SCOPES,
      bearer_methods_supported: ["header"],
    };
  }

  function asMetadata() {
    return {
      issuer: asOrigin,
      authorization_endpoint: `${asOrigin}/oauth/authorize/`,
      token_endpoint: `${asOrigin}/oauth/token/`,
      userinfo_endpoint: `${asOrigin}/oauth/userinfo/`,
      revocation_endpoint: `${asOrigin}/oauth/revoke/`,
      introspection_endpoint: `${asOrigin}/oauth/introspect/`,
      registration_endpoint: `${asOrigin}/oauth/register/`,
      jwks_uri: `${asOrigin}/.well-known/jwks.json`,
      scopes_supported: POSTHOG_SCOPES,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: [
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      ],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "private_key_jwt"],
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      posthog_region: "us",
    };
  }

  async function record(host: "mcp" | "as", req: Request): Promise<URL> {
    const url = new URL(req.url);
    requests.push({
      host,
      method: req.method,
      path: url.pathname,
      headers: req.headers,
      body: req.method === "POST" ? await req.text() : "",
    });
    return url;
  }

  function lastRequest(host: "mcp" | "as", path: string): RecordedRequest {
    const match = requests.filter((r) => r.host === host && r.path === path).at(-1);
    expect(match).toBeDefined();
    return match!;
  }

  beforeAll(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

    mcpHost = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = await record("mcp", req);
        if (url.pathname === "/.well-known/oauth-protected-resource") {
          if (!rootPrmAvailable) return new Response("not found", { status: 404 });
          // Live: the root document names the origin (no /mcp path).
          return Response.json(prm(mcpOrigin));
        }
        if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
          // Live: the path-suffixed document names the /mcp URL itself.
          return Response.json(prm(`${mcpOrigin}/mcp`));
        }
        if (url.pathname === "/mcp") {
          return new Response(
            "No token provided, please provide a valid API token. View the documentation for more information: https://posthog.com/docs/model-context-protocol",
            {
              status: 401,
              headers: {
                "WWW-Authenticate": `Bearer resource_metadata="${mcpOrigin}/.well-known/oauth-protected-resource/mcp"`,
              },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
    asHost = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = await record("as", req);
        const last = requests.at(-1)!;
        if (url.pathname === "/.well-known/oauth-authorization-server") {
          return Response.json(asMetadata());
        }
        if (url.pathname === "/oauth/register/" && req.method === "POST") {
          dcrCallCount += 1;
          const dcrBody = JSON.parse(last.body) as Record<string, unknown>;
          return Response.json(
            {
              client_id: `phc_test_client_${dcrCallCount}`,
              client_secret: `phs_test_secret_${dcrCallCount}`,
              client_id_issued_at: 1_791_504_000,
              client_secret_expires_at: 0,
              redirect_uris: dcrBody.redirect_uris,
              grant_types: dcrBody.grant_types,
              token_endpoint_auth_method: dcrBody.token_endpoint_auth_method,
              scope: dcrBody.scope,
            },
            { status: 201 },
          );
        }
        if (url.pathname === "/oauth/token/" && req.method === "POST") {
          const form = new URLSearchParams(last.body);
          if (form.get("grant_type") === "refresh_token") {
            // DCR clients get non-rotating refresh tokens: no refresh_token
            // in the refresh response.
            return Response.json({
              access_token: REFRESHED_ACCESS_TOKEN,
              token_type: "Bearer",
              expires_in: 3600,
              scope: form.get("scope") ?? READ_ONLY_SCOPES,
            });
          }
          return Response.json({
            access_token: ACCESS_TOKEN,
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: REFRESH_TOKEN,
            scope: READ_ONLY_SCOPES,
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    mcpOrigin = `http://127.0.0.1:${mcpHost.port}`;
    asOrigin = `http://127.0.0.1:${asHost.port}`;
    mcpUrl = `${mcpOrigin}/mcp`;
  });

  afterAll(() => {
    mcpHost.stop(true);
    asHost.stop(true);
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  beforeEach(async () => {
    requests = [];
    dcrCallCount = 0;
    rootPrmAvailable = true;
    process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString("base64");
    // Both fixture hosts are loopback; the SSRF guard refuses them otherwise.
    process.env.MCP_OAUTH_ALLOW_PRIVATE_HOSTS = "true";
    process.env.PUBLIC_MCP_BASE_URL = "https://swarm.example.test";
    process.env.APP_URL = "https://dashboard.example.test";

    await removeDbFiles();
    initDb(TEST_DB_PATH);
  });

  afterEach(async () => {
    closeDb();
    await removeDbFiles();
  });

  async function createPosthogServer(name = "posthog") {
    return createMcpServer({ name, transport: "http", url: mcpUrl, scope: "global" });
  }

  async function authorizeUrl(mcpServerId: string, scopes?: string) {
    const qs = scopes ? `?scopes=${encodeURIComponent(scopes)}` : "";
    const res = await dispatch(`/api/mcp-oauth/${mcpServerId}/authorize-url${qs}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    const { providerUrl } = (await res.json()) as { providerUrl: string };
    return new URL(providerUrl);
  }

  async function connect(mcpServerId: string, scopes?: string) {
    const url = await authorizeUrl(mcpServerId, scopes);
    const state = url.searchParams.get("state")!;
    const callbackRes = await dispatch(
      `/api/mcp-oauth/callback?state=${encodeURIComponent(state)}&code=example-auth-code`,
    );
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.location).toContain("oauth=success");
    return url;
  }

  test("discovery lands on the root PRM and its origin resource, then PostHog's AS endpoints", async () => {
    const server = await createPosthogServer();
    const res = await dispatch(`/api/mcp-oauth/${server.id}/metadata`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;

    // `new URL("/.well-known/…", <origin>/mcp)` drops the /mcp path, so the
    // first probe is the root document — no HEAD probe needed.
    expect(requests.map((r) => `${r.host} ${r.method} ${r.path}`)).toEqual([
      "mcp GET /.well-known/oauth-protected-resource",
      "as GET /.well-known/oauth-authorization-server",
    ]);
    expect(meta).toMatchObject({
      requiresOAuth: true,
      resourceUrl: mcpOrigin,
      authorizationServerIssuer: asOrigin,
      authorizeUrl: `${asOrigin}/oauth/authorize/`,
      tokenUrl: `${asOrigin}/oauth/token/`,
      revocationUrl: `${asOrigin}/oauth/revoke/`,
      registrationEndpoint: `${asOrigin}/oauth/register/`,
      dcrSupported: true,
      bearerMethodsSupported: ["header"],
      tokenEndpointAuthMethodsSupported: ["none", "client_secret_post", "private_key_jwt"],
      scopes: POSTHOG_SCOPES,
    });
  });

  test("without a root PRM, the 401 WWW-Authenticate resource_metadata leads to the path-suffixed PRM", async () => {
    rootPrmAvailable = false;
    const server = await createPosthogServer();
    const res = await dispatch(`/api/mcp-oauth/${server.id}/metadata`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;

    expect(requests.map((r) => `${r.host} ${r.method} ${r.path}`)).toEqual([
      "mcp GET /.well-known/oauth-protected-resource",
      "mcp HEAD /mcp",
      "mcp GET /.well-known/oauth-protected-resource/mcp",
      "as GET /.well-known/oauth-authorization-server",
    ]);
    // PostHog's path-suffixed document names the /mcp URL as its resource, so
    // this path sends resource=<origin>/mcp rather than the bare origin.
    expect(meta.resourceUrl).toBe(mcpUrl);
    expect(meta.authorizeUrl).toBe(`${asOrigin}/oauth/authorize/`);
  });

  test("DCR requests client_secret_post and the authorize URL carries S256 + the origin resource", async () => {
    const server = await createPosthogServer();
    const url = await authorizeUrl(server.id);

    expect(dcrCallCount).toBe(1);
    const dcrBody = JSON.parse(lastRequest("as", "/oauth/register/").body);
    expect(dcrBody).toMatchObject({
      redirect_uris: ["https://swarm.example.test/api/mcp-oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // PostHog advertises none / client_secret_post / private_key_jwt — no Basic.
      token_endpoint_auth_method: "client_secret_post",
      scope: POSTHOG_SCOPES.join(" "),
    });

    expect(`${url.origin}${url.pathname}`).toBe(`${asOrigin}/oauth/authorize/`);
    expect(url.searchParams.get("client_id")).toBe("phc_test_client_1");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("resource")).toBe(mcpOrigin);
    // No caller scopes → the PRM's advertised list.
    expect(url.searchParams.get("scope")).toBe(POSTHOG_SCOPES.join(" "));
  });

  test("callback exchanges with the secret in the form body and stores a connected authorization", async () => {
    const server = await createPosthogServer();
    await connect(server.id);

    const tokenReq = lastRequest("as", "/oauth/token/");
    const form = new URLSearchParams(tokenReq.body);
    expect(tokenReq.headers.get("authorization")).toBeNull();
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("client_id")).toBe("phc_test_client_1");
    expect(form.get("client_secret")).toBe("phs_test_secret_1");
    expect(form.get("code")).toBe("example-auth-code");
    expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(form.get("resource")).toBe(mcpOrigin);

    const token = await getMcpOAuthToken(server.id);
    expect(token).toMatchObject({
      status: "connected",
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      resourceUrl: mcpOrigin,
      tokenUrl: `${asOrigin}/oauth/token/`,
      dcrClientId: "phc_test_client_1",
      tokenEndpointAuthMethod: "client_secret_post",
      clientSource: "dcr",
      scope: READ_ONLY_SCOPES,
    });
    expect(token?.expiresAt).not.toBeNull();

    const statusRes = await dispatch(`/api/mcp-oauth/${server.id}/status`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(statusRes.status).toBe(200);
    const status = (await statusRes.json()) as {
      authMethod: string;
      connected: boolean;
      token: { status: string; hasRefreshToken: boolean; resourceUrl: string };
    };
    expect(status.authMethod).toBe("oauth");
    expect(status.connected).toBe(true);
    expect(status.token).toMatchObject({
      status: "connected",
      hasRefreshToken: true,
      resourceUrl: mcpOrigin,
    });
  });

  test("caller scopes are requested verbatim; an uncovered scope set forces a fresh DCR", async () => {
    const server = await createPosthogServer();

    const first = await authorizeUrl(server.id, READ_ONLY_SCOPES);
    expect(dcrCallCount).toBe(1);
    expect(first.searchParams.get("scope")).toBe(READ_ONLY_SCOPES);
    expect(JSON.parse(lastRequest("as", "/oauth/register/").body).scope).toBe(READ_ONLY_SCOPES);

    // Same set → the stored client covers it.
    const second = await authorizeUrl(server.id, READ_ONLY_SCOPES);
    expect(dcrCallCount).toBe(1);
    expect(second.searchParams.get("client_id")).toBe(first.searchParams.get("client_id"));

    // Turning read-only off adds write scopes the client wasn't registered for.
    const withWrite = `${READ_ONLY_SCOPES} insight:write`;
    const third = await authorizeUrl(server.id, withWrite);
    expect(dcrCallCount).toBe(2);
    expect(third.searchParams.get("client_id")).toBe("phc_test_client_2");
    expect(third.searchParams.get("scope")).toBe(withWrite);

    // A narrower set than the newest registration is covered — reused.
    const fourth = await authorizeUrl(server.id, "openid insight:read");
    expect(dcrCallCount).toBe(2);
    expect(fourth.searchParams.get("client_id")).toBe("phc_test_client_2");
    expect(fourth.searchParams.get("scope")).toBe("openid insight:read");
  });

  test("refresh keeps the original non-rotating phr_ refresh token and sends the origin resource", async () => {
    const server = await createPosthogServer();
    await connect(server.id, READ_ONLY_SCOPES);

    // Explicit refresh route.
    const refreshRes = await dispatch(`/api/mcp-oauth/${server.id}/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({}),
    });
    expect(refreshRes.status).toBe(200);

    let refreshReq = lastRequest("as", "/oauth/token/");
    let form = new URLSearchParams(refreshReq.body);
    expect(refreshReq.headers.get("authorization")).toBeNull();
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe(REFRESH_TOKEN);
    expect(form.get("client_secret")).toBe("phs_test_secret_1");
    expect(form.get("resource")).toBe(mcpOrigin);

    let token = await getMcpOAuthToken(server.id);
    expect(token?.accessToken).toBe(REFRESHED_ACCESS_TOKEN);
    expect(token?.refreshToken).toBe(REFRESH_TOKEN);
    expect(token?.status).toBe("connected");

    // Automatic refresh (the path agents' resolveSecrets uses). A buffer
    // longer than the 1h expiry forces it.
    const refreshesBefore = requests.filter((r) => r.path === "/oauth/token/").length;
    const ensured = await ensureMcpToken(server.id, { bufferMs: 2 * 3600_000 });
    expect(requests.filter((r) => r.path === "/oauth/token/").length).toBe(refreshesBefore + 1);

    refreshReq = lastRequest("as", "/oauth/token/");
    form = new URLSearchParams(refreshReq.body);
    expect(refreshReq.headers.get("authorization")).toBeNull();
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe(REFRESH_TOKEN);
    expect(form.get("resource")).toBe(mcpOrigin);
    expect(form.get("scope")).toBe(READ_ONLY_SCOPES);

    expect(ensured?.status).toBe("connected");
    expect(ensured?.refreshToken).toBe(REFRESH_TOKEN);
    token = await getMcpOAuthToken(server.id);
    expect(token?.refreshToken).toBe(REFRESH_TOKEN);
  });
});
