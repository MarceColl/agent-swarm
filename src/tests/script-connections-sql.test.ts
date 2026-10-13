import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { closeDb, createAgent, getDb, getDbClient, initDb } from "../be/db";
import { getScriptConnectionById, upsertScriptConnection } from "../be/script-connections";
import { handleScriptConnections } from "../http/script-connections";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { refreshSecretScrubberCache } from "../utils/secret-scrubber";

const TEST_DB_PATH = "./test-script-connections-sql.sqlite";
const API_KEY = "example-test-script-connections-sql-key-1234567890";
const DSN = "postgres://reader:sql-conn-test-password-123@db.internal.test:5432/analytics";

let leadId: string;
let workerId: string;
const savedEnv = { ...process.env };

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

async function dispatch(
  path: string,
  init: { method?: string; body?: unknown; agentId?: string } = {},
): Promise<{ status: number; text: string; json: () => Record<string, unknown> }> {
  const req = Readable.from(
    init.body === undefined ? [] : [Buffer.from(JSON.stringify(init.body))],
  ) as IncomingMessage;
  req.method = init.method ?? "GET";
  req.url = path;
  req.headers = {
    "content-type": "application/json",
    ...(init.agentId ? { "x-agent-id": init.agentId } : {}),
  };
  let status = 200;
  let text = "";
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader() {},
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) text += String(chunk);
      this.writableEnded = true;
      return this;
    },
  } as unknown as ServerResponse;
  const pathSegments = getPathSegments(path);
  const queryParams = parseQueryParams(path);
  if (!(await handleScriptConnections(req, res, pathSegments, queryParams, init.agentId))) {
    status = 404;
  }
  return { status, text, json: () => JSON.parse(text) };
}

function registerSql(body: Record<string, unknown>, agentId = leadId) {
  return dispatch("/api/script-connections", {
    method: "POST",
    agentId,
    body: { kind: "sql", slug: "analytics", ...body },
  });
}

async function configRows(key: string) {
  return getDbClient().query<{
    scope: string;
    scopeId: string | null;
    value: string;
    encrypted: number;
  }>("SELECT scope, scopeId, value, encrypted FROM swarm_config WHERE key = ?", [key]);
}

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  closeDb();
  initDb(TEST_DB_PATH);
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  delete process.env.API_KEY;
  refreshSecretScrubberCache();
});

afterAll(async () => {
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  refreshSecretScrubberCache();
});

beforeEach(async () => {
  const client = getDbClient();
  await client.run("DELETE FROM script_connections");
  await client.run("DELETE FROM script_credential_bindings");
  await client.run("DELETE FROM swarm_config");
  await client.run("DELETE FROM agents");
  leadId = (await createAgent({ name: "sql-lead", isLead: true, status: "idle" })).id;
  workerId = (await createAgent({ name: "sql-worker", isLead: false, status: "idle" })).id;
});

describe("migration 213", () => {
  test("adds 'sql' to the kind CHECK and requires a DSN key for sql rows", async () => {
    const schema = getDb()
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'script_connections'",
      )
      .get();
    expect(schema?.sql).toContain("'graphql', 'sql'");
    await expect(
      getDbClient().run(
        "INSERT INTO script_connections (id, slug, kind) VALUES (?, 'no-key', 'sql')",
        [crypto.randomUUID()],
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  test("rebuild keeps existing rows, auth columns, and managed bindings", async () => {
    const graphql = await upsertScriptConnection({
      slug: "vendor",
      kind: "graphql",
      baseUrl: "https://vendor.example.test/graphql",
      allowedHosts: ["vendor.example.test"],
      auth: { type: "bearer", secret: "vendor-secret-value-123456" },
    });
    expect(graphql.credentialBindingId).not.toBeNull();
    const before = await getDbClient().query<Record<string, unknown>>(
      "SELECT * FROM script_connections ORDER BY id",
    );

    const db = getDb();
    db.run("PRAGMA foreign_keys = OFF");
    try {
      db.exec(
        readFileSync(
          new URL("../be/migrations/213_script_connections_sql.sql", import.meta.url),
          "utf-8",
        ),
      );
    } finally {
      db.run("PRAGMA foreign_keys = ON");
    }

    const after = await getDbClient().query<Record<string, unknown>>(
      "SELECT * FROM script_connections ORDER BY id",
    );
    expect(after).toEqual(before);
    expect(after[0]?.auth_type).toBe("bearer");
    expect(after[0]?.auth_config_key).toBe("connection.vendor.secret");
    const bindings = await getDbClient().query<{ id: string }>(
      "SELECT id FROM script_credential_bindings WHERE managed_by_connection_id = ?",
      [graphql.id],
    );
    expect(bindings.map((binding) => binding.id)).toEqual([graphql.credentialBindingId!]);
  });
});

describe("sql connection registration", () => {
  test("inline DSN is stored encrypted under connection.<slug>.secret and never echoed", async () => {
    const response = await registerSql({ dsn: { secret: DSN } });
    expect(response.status).toBe(200);
    expect(response.text).not.toContain("postgres://");
    const connection = (response.json().connection ?? {}) as Record<string, unknown>;
    expect(connection).toMatchObject({
      kind: "sql",
      authType: "none",
      authConfigKey: "connection.analytics.secret",
    });

    const rows = await configRows("connection.analytics.secret");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope: "global", encrypted: 1 });
    expect(rows[0]?.value).not.toContain("postgres://");

    const stored = await getScriptConnectionById(String(connection.id));
    expect(stored?.generatedRuntimeJson).not.toContain("postgres://");
    expect(JSON.parse(stored?.generatedRuntimeJson ?? "{}")).toEqual({
      slug: "analytics",
      kind: "sql",
      connectionId: connection.id,
    });

    const detail = await dispatch(`/api/script-connections/${connection.id}`, { agentId: leadId });
    const list = await dispatch("/api/script-connections", { agentId: leadId });
    expect(detail.status).toBe(200);
    expect(list.status).toBe(200);
    expect(detail.text).not.toContain("postgres://");
    expect(list.text).not.toContain("postgres://");
  });

  test("registration is lead-only", async () => {
    const response = await registerSql({ dsn: { secret: DSN } }, workerId);
    expect(response.status).toBe(403);
    expect(await configRows("connection.analytics.secret")).toHaveLength(0);
  });

  test("rejects a non-Postgres DSN without echoing it", async () => {
    for (const secret of ["sqlite:///var/lib/swarm/agent-swarm-db.sqlite", "not a url at all"]) {
      const response = await registerSql({ dsn: { secret } });
      expect(response.status).toBe(400);
      expect(response.text).toContain("postgres://");
      expect(response.text).not.toContain(secret);
    }
  });

  test("rejects inline auth, both or neither DSN fields, and reserved config keys", async () => {
    const auth = await registerSql({
      dsn: { secret: DSN },
      auth: { type: "bearer", secret: "token-value-1234567890" },
    });
    expect(auth.status).toBe(400);
    expect(auth.text).toContain("`auth` is not supported");

    const both = await registerSql({ dsn: { secret: DSN, configKey: "ANALYTICS_DSN" } });
    expect(both.status).toBe(400);
    const missing = await registerSql({});
    expect(missing.status).toBe(400);
    expect(missing.text).toContain("dsn.secret");

    const reserved = await registerSql({ dsn: { configKey: "connection.other.secret" } });
    expect(reserved.status).toBe(400);
    expect(reserved.text).toContain("reserved");
  });

  test("configKey DSN stores the key as-is", async () => {
    const response = await registerSql({ dsn: { configKey: "ANALYTICS_DSN" } });
    expect(response.status).toBe(200);
    expect(response.json().connection).toMatchObject({ authConfigKey: "ANALYTICS_DSN" });
    expect(await configRows("connection.analytics.secret")).toHaveLength(0);
  });

  test("edit without dsn keeps the key; a slug rename with a new DSN drops the old secret", async () => {
    const created = (await registerSql({ dsn: { secret: DSN } })).json().connection as {
      id: string;
    };
    const renamed = await registerSql({ id: created.id, slug: "warehouse", displayName: "WH" });
    expect(renamed.status).toBe(200);
    expect(renamed.json().connection).toMatchObject({
      slug: "warehouse",
      authConfigKey: "connection.analytics.secret",
    });
    expect(await configRows("connection.analytics.secret")).toHaveLength(1);

    const rekeyed = await registerSql({ id: created.id, slug: "warehouse", dsn: { secret: DSN } });
    expect(rekeyed.status).toBe(200);
    expect(rekeyed.json().connection).toMatchObject({
      authConfigKey: "connection.warehouse.secret",
    });
    expect(await configRows("connection.analytics.secret")).toHaveLength(0);
    expect(await configRows("connection.warehouse.secret")).toHaveLength(1);
  });
});
