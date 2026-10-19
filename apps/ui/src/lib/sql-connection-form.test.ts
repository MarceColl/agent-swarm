import { describe, expect, test } from "bun:test";
import { buildSqlDsnInput, initialSqlDsnDraft, sqlDsnReady } from "./sql-connection-form";

const DSN = "postgres://reader:pw@db.internal:5432/analytics";

describe("SQL connection form", () => {
  test("a new connection starts on the inline secret with blank fields", () => {
    expect(initialSqlDsnDraft()).toEqual({
      useExistingConfigKey: false,
      configKey: "",
      secret: "",
    });
  });

  test("an inline DSN becomes dsn.secret, trimmed", () => {
    const draft = { useExistingConfigKey: false, configKey: "", secret: `  ${DSN}\n` };
    expect(buildSqlDsnInput(draft)).toEqual({ secret: DSN });
    expect(sqlDsnReady(draft)).toBe(true);
  });

  test("a config key reference becomes dsn.configKey and ignores a stale secret", () => {
    const draft = { useExistingConfigKey: true, configKey: " ANALYTICS_DSN ", secret: DSN };
    expect(buildSqlDsnInput(draft)).toEqual({ configKey: "ANALYTICS_DSN" });
  });

  test("a new connection with no DSN cannot save", () => {
    const draft = initialSqlDsnDraft();
    expect(buildSqlDsnInput(draft)).toBeUndefined();
    expect(sqlDsnReady(draft)).toBe(false);
    expect(sqlDsnReady({ ...draft, useExistingConfigKey: true })).toBe(false);
  });

  test("editing a SQL connection with an inline secret keeps it when left blank", () => {
    const connection = {
      kind: "sql",
      slug: "analytics",
      auth: { configKey: "connection.analytics.secret" },
    };
    const draft = initialSqlDsnDraft(connection);
    expect(draft).toEqual({ useExistingConfigKey: false, configKey: "", secret: "" });
    // No `dsn` in the body: the server reuses the stored key.
    expect(buildSqlDsnInput(draft)).toBeUndefined();
    expect(sqlDsnReady(draft, connection)).toBe(true);
  });

  test("editing a SQL connection on a shared config key prefills that key", () => {
    const connection = { kind: "sql", slug: "analytics", auth: { configKey: "ANALYTICS_DSN" } };
    const draft = initialSqlDsnDraft(connection);
    expect(draft).toEqual({ useExistingConfigKey: true, configKey: "ANALYTICS_DSN", secret: "" });
    expect(buildSqlDsnInput(draft)).toEqual({ configKey: "ANALYTICS_DSN" });
  });

  test("a non-SQL connection's auth key never prefills or preserves a DSN", () => {
    const connection = { kind: "openapi", slug: "github", auth: { configKey: "GITHUB_TOKEN" } };
    const draft = initialSqlDsnDraft(connection);
    expect(draft.useExistingConfigKey).toBe(false);
    expect(sqlDsnReady(draft, connection)).toBe(false);
  });
});
