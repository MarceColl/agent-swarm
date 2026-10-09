---
name: posthog-interaction
description: "PostHog analytics through the PostHog MCP tools: schema discovery, HogQL via execute-sql, trends, funnels, saved insights, flags, experiments, and error tracking for the operator-pinned project."
user-invocable: false
---

# PostHog Interaction

Use this skill to answer product-analytics questions from PostHog. You reach PostHog through the PostHog MCP server that the operator connected on the Integrations page. You do not need an API key, and you do not make raw HTTP calls.

## TL;DR

1. Discover before you query: call `read-data-schema` to find the real event and property names.
2. Prefer `execute-sql` (HogQL). Always add a time range and an explicit `LIMIT`.
3. Use `query-trends` / `query-funnel` / `query-retention` for standard questions, and `insight-query` to run a saved insight.
4. Link the insight or dashboard you used in your answer.
5. Read only. Never call a tool that creates, updates, or deletes data unless the task explicitly asks for it.

## Before you start

- **The project is pinned.** The operator picks one PostHog organization and project for the swarm. Do not try to switch projects. `switch-project` and `switch-organization` are not available when a project is pinned.
- **Tool names.** Your harness may prefix the tool names with the server name (for example `mcp__posthog__execute-sql`). The names below are the PostHog tool names.
- **No PostHog tools?** PostHog is not installed on this agent, or it is not connected. Do not work around it. Tell the requester to connect PostHog and install it on this agent on the **Integrations** page. The tools appear in the next session.
- **Read-only mode.** By default the server runs read-only, so write tools are hidden. If a task needs a write tool that you cannot see, say so. Do not look for another path.

## Recipes

### 1. Learn the schema first

Call `read-data-schema` before you write a query. It lists events, actions, properties, and property values. Use the exact names it returns. Guessed names like `page_view` versus `$pageview` return empty results, not errors.

### 2. Ad-hoc questions: `execute-sql` (HogQL)

HogQL is PostHog's SQL dialect. The main table is `events`. Event properties are under `properties`, for example `properties.$current_url`.

```sql
SELECT toDate(timestamp) AS day, count() AS pageviews
FROM events
WHERE event = '$pageview'
  AND timestamp >= now() - INTERVAL 7 DAY
GROUP BY day
ORDER BY day
LIMIT 100
```

Rules:

- Every query gets a time range on `timestamp`. An unbounded scan is slow and may time out.
- Every query gets an explicit `LIMIT`. Aggregate in SQL instead of pulling raw rows.
- Count unique users with `count(DISTINCT person_id)`, not `distinct_id`.
- State the time range and timezone in your answer. "Yesterday" means a calendar day, so say which one.
- If a query fails, read the error, fix the query, and retry once or twice. Do not loop.

### 3. Standard analytics questions

| Question | Tool |
|---|---|
| How did X change over time? | `query-trends` |
| Where do users drop off between steps? | `query-funnel` |
| Do users come back? | `query-retention` |
| Who are the users behind a data point? | the matching `*-actors` tool, such as `query-trends-actors` |

Use `execute-sql` when the question does not fit these shapes.

### 4. Saved insights and dashboards

- Find saved insights with `insights-list`. Run one with `insight-query`, which returns its current results.
- Find dashboards with `dashboards-get-all` and read one with `dashboard-get`.
- Prefer an existing insight when it answers the question. The team already agrees on its definition.
- Link the insight or dashboard URL in your answer so the reader can open it in PostHog.

### 5. Flags, experiments, errors, and surveys

- Feature flags: `feature-flag-get-all`, `feature-flag-get-definition`.
- Experiments: `experiment-list`, `experiment-get`, `experiment-results-get`.
- Error tracking: `query-error-tracking-issues-list`, `query-error-tracking-issue`.
- Surveys: `surveys-get-all`, `survey-get`, `survey-stats`.
- PostHog product questions ("how do cohorts work?"): `docs-search`.

PostHog adds and renames tools over time. If a tool named here is missing, check the tool list you have and pick the closest match.

## Writing answers

- Lead with the number and the time range, then the method: "1,204 pageviews on 2026-10-08 (UTC), from `execute-sql` on `$pageview` events."
- Include the HogQL you ran, or a link to the insight you used, so a human can check it.
- Say when data looks incomplete, for example a sudden drop on the current day.

## Cost and safety

- **AI-billed tools.** Some PostHog tools call an LLM internally and bill as PostHog AI usage, even in read-only mode. Prefer `execute-sql` and the `query-*` tools. Use an AI-powered tool only when the task needs it.
- **Writes.** Creating or changing flags, insights, dashboards, annotations, or experiments affects real users and teammates. Do it only when the task asks for that exact change. Confirm the target first.
- **Personal data.** Person properties can include emails and names. Do not paste them into Slack or pages unless the task needs them.

## Errors

| Symptom | Cause | Action |
|---|---|---|
| No PostHog tools at all | Not installed on this agent, or not connected | Ask the requester to connect PostHog on the Integrations page |
| `401` / unauthorized mid-session | The access token expired during a long session | Finish what you can, then start a new session. Report it if it persists |
| Status `expired` on the Integrations page | The connection can no longer refresh | Ask the operator to click **Reconnect** |
| Empty results | Wrong event or property name, or wrong time range | Re-check with `read-data-schema` and widen the range |
