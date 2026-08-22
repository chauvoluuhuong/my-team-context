/**
 * SQL database integration and connection tools.
 */

import net from "node:net";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  readSqlConnectionString,
  saveSqlConnectionString,
  clearSqlConnectionString,
} from "../utils/store.js";
import { text, guarded, RepoContextError } from "../utils/helpers.js";
import type { ValidateSqlResult, SqlStatusResult } from "./types.js";

/**
 * Parses and validates a database connection string URL.
 */
export async function validateSqlConnection(connectionString: string): Promise<ValidateSqlResult> {
  if (!connectionString || !connectionString.trim()) {
    return { valid: false, reason: "Database connection string cannot be empty." };
  }

  const raw = connectionString.trim();

  // SQLite support
  if (raw.startsWith("sqlite://") || raw.startsWith("file:")) {
    const dbPath = raw.replace(/^sqlite:\/\//, "").replace(/^file:/, "");
    return {
      valid: true,
      dialect: "sqlite",
      database: dbPath || ":memory:",
    };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      valid: false,
      reason:
        "Invalid connection string format. Expected a standard URI (e.g. postgresql://user:pass@host:5432/dbname or mysql://user:pass@host:3306/dbname).",
    };
  }

  const protocol = url.protocol.replace(/:$/, "").toLowerCase();
  const knownDialects: Record<string, number> = {
    postgres: 5432,
    postgresql: 5432,
    mysql: 3306,
    mariadb: 3306,
    mssql: 1433,
    sqlserver: 1433,
    cockroachdb: 26257,
  };

  const dialect = protocol;
  const host = url.hostname;
  const port = url.port ? Number(url.port) : knownDialects[protocol] ?? 5432;
  const database = url.pathname.replace(/^\/+/, "") || undefined;

  if (!host) {
    return { valid: false, reason: "Database connection string is missing a host." };
  }

  // Attempt a TCP connection test if port and host are present
  const reachable = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(3500);

    socket.on("connect", () => {
      socket.destroy();
      resolve({ ok: true });
    });

    socket.on("timeout", () => {
      socket.destroy();
      resolve({ ok: false, error: "Connection timed out after 3.5s" });
    });

    socket.on("error", (err) => {
      socket.destroy();
      resolve({ ok: false, error: err.message });
    });

    socket.connect(port, host);
  });

  if (!reachable.ok) {
    return {
      valid: false,
      dialect,
      host,
      port,
      database,
      reason: `Could not reach ${host}:${port} (${reachable.error}). Verify the database host, port, and firewall rules.`,
    };
  }

  return {
    valid: true,
    dialect,
    host,
    port,
    database,
  };
}

/**
 * Check the connection status with the stored or provided SQL connection string.
 */
export async function sqlCheckConnection(
  connectionStringOverride?: string,
): Promise<SqlStatusResult> {
  const conn = connectionStringOverride?.trim() || (await readSqlConnectionString());
  if (!conn) {
    return {
      connected: false,
      reason:
        "No SQL connection string configured yet. Call save_sql_config to configure your database.",
    };
  }

  const check = await validateSqlConnection(conn);
  if (!check.valid) {
    return {
      connected: false,
      dialect: check.dialect,
      database: check.database,
      host: check.host,
      reason: check.reason,
    };
  }

  return {
    connected: true,
    dialect: check.dialect,
    database: check.database,
    host: check.host,
  };
}

export function registerSqlTools(server: McpServer): void {
  server.registerTool(
    "sql_check_connection",
    {
      title: "Check SQL database connection",
      description:
        "Test connectivity to a PostgreSQL, MySQL, or other SQL database using the stored or provided connection URI.",
      annotations: { title: "Check SQL database connection", readOnlyHint: true },
      inputSchema: {
        connectionString: z
          .string()
          .optional()
          .describe("Optional database connection string to test without saving."),
      },
    },
    guarded(async ({ connectionString }: { connectionString?: string }) => {
      const status = await sqlCheckConnection(connectionString);
      return text({
        connected: status.connected,
        dialect: status.dialect ?? null,
        database: status.database ?? null,
        host: status.host ?? null,
        status: status.connected ? "ok" : "error",
        detail: status.connected
          ? `Successfully reached ${status.dialect} database "${status.database ?? ""}" on ${status.host}.`
          : status.reason,
      });
    }),
  );

  server.registerTool(
    "save_sql_config",
    {
      title: "Save SQL database connection",
      description: "Validate and securely store a database connection string in the OS keychain.",
      annotations: { title: "Save SQL database connection", readOnlyHint: false },
      inputSchema: {
        connectionString: z
          .string()
          .min(1)
          .describe(
            "Database connection URI (e.g. postgresql://user:password@host:5432/dbname)",
          ),
      },
    },
    guarded(async ({ connectionString }: { connectionString: string }) => {
      const check = await validateSqlConnection(connectionString);
      if (!check.valid) {
        throw new RepoContextError(`Invalid SQL connection string: ${check.reason}`);
      }

      const { stored, warning } = await saveSqlConnectionString(connectionString);
      return text({
        status: "ok",
        dialect: check.dialect,
        database: check.database,
        host: check.host,
        storage: stored,
        warning,
        message: `Database connection string validated and stored in ${stored}.`,
      });
    }),
  );

  server.registerTool(
    "sql_disconnect",
    {
      title: "Disconnect SQL database",
      description: "Remove the stored SQL database connection string from this machine.",
      annotations: { title: "Disconnect SQL database", readOnlyHint: false, destructiveHint: true },
      inputSchema: {},
    },
    guarded(async () => {
      await clearSqlConnectionString();
      return text("SQL database disconnected — the stored connection string was removed.");
    }),
  );
}
