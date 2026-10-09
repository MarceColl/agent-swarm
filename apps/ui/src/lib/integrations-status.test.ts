import { describe, expect, test } from "bun:test";
import type { SwarmConfig } from "../api/types";
import { INTEGRATIONS } from "./integrations-catalog";
import { deriveIntegrationStatus, mcpOAuthIntegrationStatus } from "./integrations-status";

const posthog = INTEGRATIONS.find((integration) => integration.id === "posthog")!;
const linear = INTEGRATIONS.find((integration) => integration.id === "linear")!;

function row(key: string, value: string): SwarmConfig {
  return {
    id: key,
    scope: "global",
    scopeId: null,
    key,
    value,
    isSecret: false,
    envPath: null,
    description: null,
    createdAt: "2026-10-09T00:00:00.000Z",
    lastUpdatedAt: "2026-10-09T00:00:00.000Z",
    encrypted: false,
  };
}

describe("mcpOAuthIntegrationStatus", () => {
  test("maps OAuth token status to card status", () => {
    expect(mcpOAuthIntegrationStatus("connected")).toBe("configured");
    expect(mcpOAuthIntegrationStatus("expired")).toBe("partial");
    expect(mcpOAuthIntegrationStatus("error")).toBe("partial");
    expect(mcpOAuthIntegrationStatus("revoked")).toBe("none");
    expect(mcpOAuthIntegrationStatus("none")).toBe("none");
  });
});

describe("deriveIntegrationStatus with flow statuses", () => {
  test("PostHog takes its status from the OAuth connection", () => {
    expect(deriveIntegrationStatus(posthog, [], {}, { "posthog-mcp": "configured" })).toBe(
      "configured",
    );
    expect(deriveIntegrationStatus(posthog, [], {}, { "posthog-mcp": "partial" })).toBe("partial");
  });

  test("PostHog without a flow status is not configured", () => {
    expect(deriveIntegrationStatus(posthog, [], {})).toBe("none");
  });

  test("other flows ignore flow statuses they do not own", () => {
    const withoutFlow = deriveIntegrationStatus(linear, [row("LINEAR_CLIENT_ID", "x")], {});
    const withFlow = deriveIntegrationStatus(
      linear,
      [row("LINEAR_CLIENT_ID", "x")],
      {},
      { "posthog-mcp": "configured" },
    );
    expect(withFlow).toBe(withoutFlow);
  });
});
