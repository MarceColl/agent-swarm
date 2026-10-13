/** Only Postgres: Bun `SQL` would open a `sqlite://` URL as a file on the API host. Never echo the DSN. */
export function assertPostgresDsn(dsn: string): void {
  if (!URL.canParse(dsn) || !["postgres:", "postgresql:"].includes(new URL(dsn).protocol)) {
    throw new Error("SQL connection DSN must be a postgres:// or postgresql:// URL.");
  }
}
