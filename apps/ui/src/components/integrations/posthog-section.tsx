import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ChevronDown, ExternalLink, Link as LinkIcon, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useAgents } from "@/api/hooks/use-agents";
import {
  useDisconnectMcpOAuth,
  useMcpOAuthMetadata,
  useStartMcpOAuthConnect,
} from "@/api/hooks/use-mcp-oauth";
import {
  POSTHOG_INTEGRATION_QUERY_KEY,
  type PosthogIntegration,
  type PosthogOAuthStatus,
  type PosthogRegion,
  usePosthogIntegration,
  usePosthogProjects,
  useSavePosthogIntegration,
} from "@/api/hooks/use-posthog-integration";
import type { AgentWithTasks } from "@/api/types";
import {
  OAuthSection,
  OAuthSectionRow,
  OAuthStatusRow,
  type OAuthStatusTone,
} from "@/components/shared/oauth-section";
import { AlertCallout } from "@/components/ui/alert-callout";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsRow } from "@/components/ui/settings-row";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useUrlSearchState } from "@/hooks/use-url-search-state";

// ---------------------------------------------------------------------------
// PostHog guided setup. One global MCP server row, four steps:
//   1. region + read-only mode (PUT creates or updates the row)
//   2. connect through the generic MCP OAuth flow
//   3. pin an organization + project
//   4. install the server on agents
// Backend: src/http/integrations.ts (PostHog routes).
// ---------------------------------------------------------------------------

const REGION_OPTIONS = [
  { value: "us", label: "US cloud" },
  { value: "eu", label: "EU cloud" },
] as const;

const REGION_LABELS: Record<PosthogRegion, string> = { us: "US cloud", eu: "EU cloud" };

/** Mirrors `posthogReadScopes` in src/integrations/posthog/config.ts. */
const POSTHOG_IDENTITY_SCOPES = new Set(["openid", "profile", "email"]);
function posthogReadScopes(scopes: string[]): string[] {
  return scopes.filter((scope) => scope.endsWith(":read") || POSTHOG_IDENTITY_SCOPES.has(scope));
}

const STATUS_ROW: Record<PosthogOAuthStatus, { label: string; tone: OAuthStatusTone }> = {
  none: { label: "Not connected", tone: "neutral" },
  connected: { label: "Connected to PostHog", tone: "success" },
  expired: { label: "Connection expired", tone: "active" },
  error: { label: "Connection error", tone: "error" },
  revoked: { label: "Connection revoked", tone: "neutral" },
};

/** Leads plus workers whose name, role, or description mentions research. */
function suggestedAgentIds(agents: AgentWithTasks[]): string[] {
  return agents
    .filter(
      (agent) =>
        agent.isLead ||
        /research/i.test([agent.name, agent.role ?? "", agent.description ?? ""].join(" ")),
    )
    .map((agent) => agent.id);
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((item) => set.has(item));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function PosthogSection() {
  const { data, isLoading, error } = usePosthogIntegration();
  const [regionDraft, setRegionDraft] = useState<PosthogRegion | null>(null);
  const [readOnlyDraft, setReadOnlyDraft] = useState<boolean | null>(null);
  useOAuthReturn();

  if (isLoading) {
    return <Skeleton className="h-48 w-full" />;
  }
  if (error || !data) {
    return (
      <AlertCallout tone="error" icon={AlertCircle}>
        Failed to load the PostHog integration: {errorMessage(error)}
      </AlertCallout>
    );
  }

  const region = regionDraft ?? data.region;
  const readOnly = readOnlyDraft ?? data.readOnly;
  const setupDirty = !data.mcpServerId || region !== data.region || readOnly !== data.readOnly;
  const connected = data.oauthStatus === "connected";

  return (
    <div className="space-y-6">
      <SetupStep
        state={data}
        region={region}
        readOnly={readOnly}
        dirty={setupDirty}
        onRegionChange={setRegionDraft}
        onReadOnlyChange={setReadOnlyDraft}
        onSaved={() => {
          setRegionDraft(null);
          setReadOnlyDraft(null);
        }}
      />
      <ConnectionStep state={data} setupDirty={setupDirty} />
      {connected && <ProjectStep state={data} />}
      {data.mcpServerId && <AgentsStep state={data} />}
    </div>
  );
}

/** Report the OAuth result once after the provider redirects back, then strip the params. */
function useOAuthReturn() {
  const qc = useQueryClient();
  const { searchParams, setParams } = useUrlSearchState();
  const oauthParam = searchParams.get("oauth");
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!oauthParam || handled.current === oauthParam) return;
    handled.current = oauthParam;
    if (oauthParam === "success") {
      toast.success("PostHog connected");
    } else if (oauthParam === "error") {
      toast.error(
        searchParams.get("error_description") ||
          searchParams.get("error") ||
          "PostHog authorization failed",
      );
    }
    void qc.invalidateQueries({ queryKey: POSTHOG_INTEGRATION_QUERY_KEY });
    void qc.invalidateQueries({ queryKey: ["mcp-oauth-status"] });
    setParams({ oauth: "", error: "", error_description: "" });
  }, [oauthParam, searchParams, setParams, qc]);
}

// --------------------------------------------------------------- Step 1

interface SetupStepProps {
  state: PosthogIntegration;
  region: PosthogRegion;
  readOnly: boolean;
  dirty: boolean;
  onRegionChange: (region: PosthogRegion) => void;
  onReadOnlyChange: (readOnly: boolean) => void;
  onSaved: () => void;
}

function SetupStep({
  state,
  region,
  readOnly,
  dirty,
  onRegionChange,
  onReadOnlyChange,
  onSaved,
}: SetupStepProps) {
  const save = useSavePosthogIntegration();
  const hasConnection = state.oauthStatus !== "none";

  function handleSave() {
    save.mutate(
      { region, readOnly },
      {
        onSuccess: onSaved,
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <OAuthSection title="Region and access">
      <div className="p-4 space-y-4">
        <SettingsRow
          label="Region"
          helper="The cloud your PostHog account lives in. Changing it disconnects PostHog."
        >
          <SegmentedControl
            aria-label="PostHog region"
            size="sm"
            value={region}
            onValueChange={onRegionChange}
            options={REGION_OPTIONS}
          />
        </SettingsRow>
        <SettingsRow
          label="Read-only"
          htmlFor="posthog-read-only"
          helper="Hides write tools and requests read scopes only. Turning it off needs a Reconnect to grant write scopes."
        >
          <Switch id="posthog-read-only" checked={readOnly} onCheckedChange={onReadOnlyChange} />
        </SettingsRow>
        {hasConnection && region !== state.region && (
          <AlertCallout tone="warning" icon={AlertCircle}>
            Saving disconnects PostHog. Connect again for the {REGION_LABELS[region]}.
          </AlertCallout>
        )}
        {state.oauthStatus === "connected" && state.readOnly && !readOnly && (
          <AlertCallout tone="info" icon={AlertCircle}>
            After saving, Reconnect to grant write scopes.
          </AlertCallout>
        )}
      </div>
      <OAuthSectionRow className="flex justify-end space-y-0">
        <Button
          type="button"
          size="sm"
          onClick={handleSave}
          disabled={!dirty && save.isIdle}
          status={save.isPending ? "loading" : save.isSuccess ? "success" : "idle"}
          successLabel="Saved"
          onStatusChange={save.reset}
        >
          Save
        </Button>
      </OAuthSectionRow>
    </OAuthSection>
  );
}

// --------------------------------------------------------------- Step 2

function ConnectionStep({ state, setupDirty }: { state: PosthogIntegration; setupDirty: boolean }) {
  const qc = useQueryClient();
  const mcpServerId = state.mcpServerId ?? "";
  const metadata = useMcpOAuthMetadata(mcpServerId, !!state.mcpServerId);
  const startConnect = useStartMcpOAuthConnect();
  const disconnect = useDisconnectMcpOAuth();

  const connected = state.oauthStatus === "connected";
  const row = STATUS_ROW[state.oauthStatus];
  const blockedReason = !state.mcpServerId
    ? "Save the region first."
    : setupDirty
      ? "Save your changes first."
      : null;

  async function handleConnect() {
    if (blockedReason || !state.mcpServerId) return;
    let scopes: string | undefined;
    if (state.readOnly) {
      const advertised = metadata.data?.scopes ?? (await metadata.refetch()).data?.scopes ?? [];
      const readScopes = posthogReadScopes(advertised);
      if (readScopes.length === 0) {
        toast.error(
          metadata.error
            ? `Could not load PostHog's scopes: ${errorMessage(metadata.error)}`
            : "Could not load PostHog's scopes. Try again.",
        );
        return;
      }
      scopes = readScopes.join(" ");
    }
    const redirect = `${window.location.origin}${window.location.pathname}`;
    startConnect.mutate(
      { mcpServerId: state.mcpServerId, options: { redirect, scopes } },
      {
        onSuccess: ({ providerUrl }) => {
          window.location.href = providerUrl;
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  function handleDisconnect() {
    if (!state.mcpServerId) return;
    disconnect.mutate(state.mcpServerId, {
      onSuccess: () => {
        toast.success("PostHog disconnected");
        void qc.invalidateQueries({ queryKey: POSTHOG_INTEGRATION_QUERY_KEY });
      },
      onError: (err) => toast.error(err.message),
    });
  }

  const description = connected
    ? `${REGION_LABELS[state.region]}, ${state.readOnly ? "read-only" : "read and write"}.`
    : state.mcpServerId
      ? "Authorize your PostHog account through OAuth."
      : "Save the region first, then connect.";

  return (
    <OAuthSection title="Connection">
      <OAuthStatusRow
        tone={row.tone}
        label={row.label}
        description={description}
        actions={
          <Tooltip open={blockedReason ? undefined : false}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant={connected ? "outline" : "default"}
                aria-disabled={blockedReason ? true : undefined}
                className="aria-disabled:opacity-50"
                onClick={() => void handleConnect()}
                disabled={disconnect.isPending}
                // Stays loading after success while the browser leaves for PostHog.
                status={startConnect.isPending || startConnect.isSuccess ? "loading" : "idle"}
              >
                <LinkIcon className="h-3.5 w-3.5" />
                {connected ? "Reconnect" : "Connect PostHog"}
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{blockedReason}</TooltipContent>
          </Tooltip>
        }
      />
      {(state.oauthStatus === "expired" || state.oauthStatus === "error") &&
        state.lastErrorMessage && (
          <OAuthSectionRow>
            <AlertCallout tone="active" icon={AlertCircle} title="Last error">
              {state.lastErrorMessage}
            </AlertCallout>
          </OAuthSectionRow>
        )}
      {state.oauthStatus !== "none" && (
        <OAuthSectionRow className="flex items-center space-y-0">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="destructive-outline"
                disabled={disconnect.isPending}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Disconnect PostHog?</AlertDialogTitle>
                <AlertDialogDescription>
                  This revokes the PostHog grant (best effort) and removes the stored tokens. Agents
                  lose PostHog tools until you connect again.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleDisconnect}>Disconnect</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </OAuthSectionRow>
      )}
    </OAuthSection>
  );
}

// --------------------------------------------------------------- Step 3

interface ProjectPick {
  organizationId: string | null;
  projectId: string | null;
}

function ProjectStep({ state }: { state: PosthogIntegration }) {
  const projects = usePosthogProjects(true);
  const save = useSavePosthogIntegration();
  const [pick, setPick] = useState<ProjectPick | null>(null);

  const organizations = projects.data ?? [];
  const current: ProjectPick = pick ?? {
    organizationId:
      state.organizationId ?? (organizations.length === 1 ? organizations[0].id : null),
    projectId: state.projectId,
  };
  const org = organizations.find((o) => o.id === current.organizationId);
  const dirty =
    current.projectId !== null &&
    (current.projectId !== state.projectId || current.organizationId !== state.organizationId);

  function handleOrgChange(organizationId: string) {
    const next = organizations.find((o) => o.id === organizationId);
    setPick({
      organizationId,
      projectId: next?.projects.length === 1 ? next.projects[0].id : null,
    });
  }

  function handleSave() {
    save.mutate(
      {
        region: state.region,
        readOnly: state.readOnly,
        organizationId: current.organizationId,
        projectId: current.projectId,
      },
      {
        onSuccess: () => setPick(null),
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <OAuthSection title="Project">
      <div className="p-4 space-y-4">
        {projects.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : projects.error ? (
          <AlertCallout tone="error" icon={AlertCircle}>
            Failed to load PostHog projects: {errorMessage(projects.error)}
          </AlertCallout>
        ) : organizations.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            This PostHog account has no organizations.
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <SettingsRow label="Organization" htmlFor="posthog-org">
              <Select value={current.organizationId ?? ""} onValueChange={handleOrgChange}>
                <SelectTrigger id="posthog-org" className="w-full">
                  <SelectValue placeholder="Pick an organization" />
                </SelectTrigger>
                <SelectContent>
                  {organizations.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsRow>
            <SettingsRow label="Project" htmlFor="posthog-project">
              <Select
                value={current.projectId ?? ""}
                onValueChange={(projectId) =>
                  setPick({ organizationId: current.organizationId, projectId })
                }
                disabled={!org}
              >
                <SelectTrigger id="posthog-project" className="w-full">
                  <SelectValue placeholder="Pick a project" />
                </SelectTrigger>
                <SelectContent>
                  {org?.projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsRow>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Agents query this project only. Pinning it hides PostHog's project switch tools.
        </p>
      </div>
      <OAuthSectionRow className="flex justify-end space-y-0">
        <Button
          type="button"
          size="sm"
          onClick={handleSave}
          disabled={!dirty && save.isIdle}
          status={save.isPending ? "loading" : save.isSuccess ? "success" : "idle"}
          successLabel="Saved"
          onStatusChange={save.reset}
        >
          Save
        </Button>
      </OAuthSectionRow>
    </OAuthSection>
  );
}

// --------------------------------------------------------------- Step 4

function AgentsStep({ state }: { state: PosthogIntegration }) {
  const { data: agents = [], isLoading } = useAgents();
  const save = useSavePosthogIntegration();
  const [draft, setDraft] = useState<string[] | null>(null);

  const installed = state.installedAgentIds;
  const selected = draft ?? (installed.length > 0 ? installed : suggestedAgentIds(agents));
  const dirty = !sameSet(selected, installed);
  const names = agents.filter((a) => selected.includes(a.id)).map((a) => a.name);

  function toggle(agentId: string, checked: boolean) {
    setDraft(checked ? [...selected, agentId] : selected.filter((id) => id !== agentId));
  }

  function handleSave() {
    save.mutate(
      { region: state.region, readOnly: state.readOnly, agentIds: selected },
      {
        onSuccess: () => setDraft(null),
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <OAuthSection title="Agents">
      <div className="p-4 space-y-2">
        {isLoading ? (
          <Skeleton className="h-9 w-full" />
        ) : (
          <SettingsRow
            label="Install on"
            htmlFor="posthog-agents"
            helper="Agents get PostHog tools in their next session."
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  id="posthog-agents"
                  type="button"
                  variant="outline"
                  className="w-full justify-between"
                  disabled={agents.length === 0}
                >
                  <span className="truncate">
                    {agents.length === 0
                      ? "No agents registered"
                      : names.length > 0
                        ? names.join(", ")
                        : "No agents selected"}
                  </span>
                  <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-64">
                {agents.map((agent) => (
                  <DropdownMenuCheckboxItem
                    key={agent.id}
                    checked={selected.includes(agent.id)}
                    onSelect={(event) => event.preventDefault()}
                    onCheckedChange={(checked) => toggle(agent.id, checked)}
                  >
                    <span className="truncate">{agent.name}</span>
                    {agent.isLead && (
                      <Badge variant="outline" size="tag" className="ml-auto">
                        Lead
                      </Badge>
                    )}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </SettingsRow>
        )}
      </div>
      <OAuthSectionRow className="flex justify-end space-y-0">
        <Button
          type="button"
          size="sm"
          onClick={handleSave}
          disabled={!dirty && save.isIdle}
          status={save.isPending ? "loading" : save.isSuccess ? "success" : "idle"}
          successLabel="Saved"
          onStatusChange={save.reset}
        >
          Save
        </Button>
      </OAuthSectionRow>
    </OAuthSection>
  );
}
