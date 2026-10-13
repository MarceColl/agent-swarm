import { getDbClient } from "./runtime";

/** Agent IDs with this MCP server installed (any active state), sorted. */
export async function getMcpServerInstalledAgentIds(mcpServerId: string): Promise<string[]> {
  const rows = await getDbClient().query<{ agentId: string }>(
    "SELECT agentId FROM agent_mcp_servers WHERE mcpServerId = ? ORDER BY agentId ASC",
    [mcpServerId],
  );
  return rows.map((row) => row.agentId);
}
