// Pure form logic for the `sql` kind in the Add/Edit Connection dialog
// (`pages/connections/page.tsx`). The Postgres DSN is write-only: either an
// inline secret the server stores under `connection.<slug>.secret`, or an
// existing swarm_config key. The server echoes back only that key, as the
// connection's `auth.configKey`.

export type SqlDsnInput = { secret: string } | { configKey: string };

export type SqlDsnDraft = {
  useExistingConfigKey: boolean;
  configKey: string;
  secret: string;
};

type SqlConnectionLike = {
  kind: string;
  slug: string;
  auth?: { configKey?: string } | null;
};

/** The server's own key for an inline DSN secret. */
export function sqlDsnSecretKey(slug: string): string {
  return `connection.${slug}.secret`;
}

/**
 * Prefill the DSN fields. A stored inline secret is never echoed, so the
 * secret stays blank; a shared config key is shown so it can be kept or changed.
 */
export function initialSqlDsnDraft(connection?: SqlConnectionLike): SqlDsnDraft {
  const storedKey = connection?.kind === "sql" ? connection.auth?.configKey : undefined;
  const sharedKey = Boolean(storedKey && storedKey !== sqlDsnSecretKey(connection?.slug ?? ""));
  return {
    useExistingConfigKey: sharedKey,
    configKey: sharedKey ? (storedKey ?? "") : "",
    secret: "",
  };
}

/** The upsert body's `dsn`, or undefined when nothing was entered (edit keeps the stored DSN). */
export function buildSqlDsnInput(draft: SqlDsnDraft): SqlDsnInput | undefined {
  if (draft.useExistingConfigKey) {
    const configKey = draft.configKey.trim();
    return configKey ? { configKey } : undefined;
  }
  const secret = draft.secret.trim();
  return secret ? { secret } : undefined;
}

/**
 * The DSN section can save. A blank secret is valid only when editing a
 * connection that is already `sql`; the server then keeps the stored DSN.
 */
export function sqlDsnReady(draft: SqlDsnDraft, existing?: Pick<SqlConnectionLike, "kind">) {
  if (buildSqlDsnInput(draft)) return true;
  return !draft.useExistingConfigKey && existing?.kind === "sql";
}
