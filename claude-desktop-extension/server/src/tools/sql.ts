/**
 * SQL database integration, schema inspection, and query execution tools.
 */

import net from "node:net";
import { z } from "zod";
import pg from "pg";
import mysql from "mysql2/promise";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  readSqlConnectionString,
  saveSqlConnectionString,
  clearSqlConnectionString,
} from "../utils/store.js";
import { text, guarded, RepoContextError } from "../utils/helpers.js";
import type { ValidateSqlResult, SqlStatusResult } from "./types.js";

const { Client: PgClient } = pg;

export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue?: string | null;
  isPrimaryKey?: boolean;
}

export interface SchemaForeignKey {
  column: string;
  foreignTable: string;
  foreignColumn: string;
}

export interface SchemaTable {
  schema?: string;
  name: string;
  type: "table" | "view";
  columns: SchemaColumn[];
  primaryKeys: string[];
  foreignKeys: SchemaForeignKey[];
}

export interface DatabaseSchemaResult {
  dialect: string;
  database?: string;
  tablesCount: number;
  tables: SchemaTable[];
}

export interface QueryExecutionResult {
  dialect: string;
  database?: string;
  rowCount: number;
  columns?: string[];
  rows?: Record<string, unknown>[];
  durationMs: number;
  truncated?: boolean;
  command?: string;
}

/**
 * Parses and validates a database connection string URL.
 */
export async function validateSqlConnection(connectionString: string): Promise<ValidateSqlResult> {
  if (!connectionString || !connectionString.trim()) {
    return { valid: false, reason: "Database connection string cannot be empty." };
  }

  const raw = connectionString.trim();

  // SQLite support
  if (raw.startsWith("sqlite://") || raw.startsWith("file:") || raw.endsWith(".sqlite") || raw.endsWith(".db")) {
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

/* ------------------------------------------------------------------ *
 * Schema Extraction Implementations
 * ------------------------------------------------------------------ */

async function getPostgresSchema(
  connectionString: string,
  filterSchema?: string,
  filterTables?: string[],
): Promise<DatabaseSchemaResult> {
  const client = new PgClient({ connectionString, statement_timeout: 30000 });
  await client.connect();
  try {
    const targetSchema = filterSchema?.trim() || "public";

    // 1. Tables and Views
    const tablesQuery = `
      SELECT table_schema, table_name, table_type
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ${filterSchema ? `AND table_schema = $1` : ""}
      ORDER BY table_schema, table_name;
    `;
    const tablesRes = await client.query(tablesQuery, filterSchema ? [targetSchema] : []);

    // 2. Columns
    const columnsQuery = `
      SELECT table_schema, table_name, column_name, data_type, udt_name, is_nullable, column_default, ordinal_position
      FROM information_schema.columns
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ${filterSchema ? `AND table_schema = $1` : ""}
      ORDER BY table_schema, table_name, ordinal_position;
    `;
    const columnsRes = await client.query(columnsQuery, filterSchema ? [targetSchema] : []);

    // 3. Constraints (Primary Keys & Foreign Keys)
    const constraintsQuery = `
      SELECT 
        tc.table_schema, 
        tc.table_name, 
        kcu.column_name, 
        tc.constraint_type,
        ccu.table_schema AS foreign_table_schema,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      LEFT JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')
        AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
        ${filterSchema ? `AND tc.table_schema = $1` : ""};
    `;
    const constraintsRes = await client.query(constraintsQuery, filterSchema ? [targetSchema] : []).catch(() => ({ rows: [] }));

    const tableMap = new Map<string, SchemaTable>();
    for (const t of tablesRes.rows) {
      const key = `${t.table_schema}.${t.table_name}`;
      if (filterTables && filterTables.length > 0 && !filterTables.includes(t.table_name) && !filterTables.includes(key)) {
        continue;
      }
      tableMap.set(key, {
        schema: t.table_schema,
        name: t.table_name,
        type: t.table_type === "VIEW" ? "view" : "table",
        columns: [],
        primaryKeys: [],
        foreignKeys: [],
      });
    }

    const pksByTable = new Map<string, Set<string>>();
    const fksByTable = new Map<string, SchemaForeignKey[]>();

    for (const c of constraintsRes.rows) {
      const key = `${c.table_schema}.${c.table_name}`;
      if (c.constraint_type === "PRIMARY KEY") {
        if (!pksByTable.has(key)) pksByTable.set(key, new Set());
        pksByTable.get(key)!.add(c.column_name);
      } else if (c.constraint_type === "FOREIGN KEY" && c.foreign_table_name) {
        if (!fksByTable.has(key)) fksByTable.set(key, []);
        fksByTable.get(key)!.push({
          column: c.column_name,
          foreignTable: c.foreign_table_name,
          foreignColumn: c.foreign_column_name,
        });
      }
    }

    for (const col of columnsRes.rows) {
      const key = `${col.table_schema}.${col.table_name}`;
      const tbl = tableMap.get(key);
      if (!tbl) continue;
      const isPk = pksByTable.get(key)?.has(col.column_name) || false;
      tbl.columns.push({
        name: col.column_name,
        type: col.udt_name || col.data_type,
        nullable: col.is_nullable === "YES",
        defaultValue: col.column_default || null,
        isPrimaryKey: isPk,
      });
    }

    for (const [key, tbl] of tableMap.entries()) {
      tbl.primaryKeys = Array.from(pksByTable.get(key) || []);
      tbl.foreignKeys = fksByTable.get(key) || [];
    }

    return {
      dialect: "postgresql",
      database: client.database || undefined,
      tablesCount: tableMap.size,
      tables: Array.from(tableMap.values()),
    };
  } finally {
    await client.end().catch(() => {});
  }
}

async function getMysqlSchema(
  connectionString: string,
  filterSchema?: string,
  filterTables?: string[],
): Promise<DatabaseSchemaResult> {
  const conn = await mysql.createConnection(connectionString);
  try {
    const [cols] = await conn.query<any[]>(`
      SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA
      FROM information_schema.columns
      WHERE TABLE_SCHEMA = DATABASE()
      ORDER BY TABLE_NAME, ORDINAL_POSITION;
    `);

    const tableMap = new Map<string, SchemaTable>();
    for (const col of cols) {
      const tableName = col.TABLE_NAME;
      if (filterTables && filterTables.length > 0 && !filterTables.includes(tableName)) {
        continue;
      }
      if (!tableMap.has(tableName)) {
        tableMap.set(tableName, {
          schema: col.TABLE_SCHEMA,
          name: tableName,
          type: "table",
          columns: [],
          primaryKeys: [],
          foreignKeys: [],
        });
      }
      const isPk = col.COLUMN_KEY === "PRI";
      tableMap.get(tableName)!.columns.push({
        name: col.COLUMN_NAME,
        type: col.COLUMN_TYPE || col.DATA_TYPE,
        nullable: col.IS_NULLABLE === "YES",
        defaultValue: col.COLUMN_DEFAULT || null,
        isPrimaryKey: isPk,
      });
      if (isPk && !tableMap.get(tableName)!.primaryKeys.includes(col.COLUMN_NAME)) {
        tableMap.get(tableName)!.primaryKeys.push(col.COLUMN_NAME);
      }
    }

    return {
      dialect: "mysql",
      database: (conn as any).config?.database || undefined,
      tablesCount: tableMap.size,
      tables: Array.from(tableMap.values()),
    };
  } finally {
    await conn.end().catch(() => {});
  }
}

async function getSqliteSchema(
  connectionString: string,
  filterTables?: string[],
): Promise<DatabaseSchemaResult> {
  const dbPath = connectionString.replace(/^sqlite:\/\//, "").replace(/^file:/, "") || ":memory:";
  const sqliteMod = await import("node:sqlite");
  const db = new sqliteMod.DatabaseSync(dbPath);
  try {
    const stmt = db.prepare("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%';");
    const masterRows = stmt.all() as { name: string; type: string; sql: string }[];
    const tables: SchemaTable[] = [];

    for (const row of masterRows) {
      if (filterTables && filterTables.length > 0 && !filterTables.includes(row.name)) {
        continue;
      }
      const infoStmt = db.prepare(`PRAGMA table_info("${row.name.replace(/"/g, '""')}");`);
      const colRows = infoStmt.all() as { cid: number; name: string; type: string; notnull: number; dflt_value: any; pk: number }[];
      const pks: string[] = [];
      const columns: SchemaColumn[] = colRows.map(c => {
        const isPk = c.pk > 0;
        if (isPk) pks.push(c.name);
        return {
          name: c.name,
          type: c.type || "TEXT",
          nullable: c.notnull === 0,
          defaultValue: c.dflt_value,
          isPrimaryKey: isPk,
        };
      });

      tables.push({
        name: row.name,
        type: row.type === "view" ? "view" : "table",
        columns,
        primaryKeys: pks,
        foreignKeys: [],
      });
    }

    return {
      dialect: "sqlite",
      database: dbPath,
      tablesCount: tables.length,
      tables,
    };
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------ *
 * Query Execution Implementations
 * ------------------------------------------------------------------ */

async function executePostgresQuery(
  connectionString: string,
  sql: string,
  limit: number = 100,
): Promise<QueryExecutionResult> {
  const client = new PgClient({ connectionString, statement_timeout: 30000 });
  await client.connect();
  try {
    const start = Date.now();
    const res = await client.query(sql);
    const durationMs = Date.now() - start;

    if (Array.isArray(res)) {
      const lastRes = res[res.length - 1];
      const rows = (lastRes.rows || []) as Record<string, unknown>[];
      const truncated = rows.length > limit;
      return {
        dialect: "postgresql",
        database: client.database || undefined,
        rowCount: lastRes.rowCount || rows.length,
        columns: lastRes.fields?.map((f: { name: string }) => f.name) || [],
        rows: truncated ? rows.slice(0, limit) : rows,
        durationMs,
        truncated,
        command: lastRes.command,
      };
    }

    const rows = (res.rows || []) as Record<string, unknown>[];
    const truncated = rows.length > limit;
    return {
      dialect: "postgresql",
      database: client.database || undefined,
      rowCount: res.rowCount ?? rows.length,
      columns: res.fields?.map((f: { name: string }) => f.name) || (rows.length > 0 ? Object.keys(rows[0]) : []),
      rows: truncated ? rows.slice(0, limit) : rows,
      durationMs,
      truncated,
      command: res.command,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

async function executeMysqlQuery(
  connectionString: string,
  sql: string,
  limit: number = 100,
): Promise<QueryExecutionResult> {
  const conn = await mysql.createConnection(connectionString);
  try {
    const start = Date.now();
    const [rows, fields] = await conn.query(sql);
    const durationMs = Date.now() - start;

    if (Array.isArray(rows)) {
      const allRows = rows as unknown as Record<string, unknown>[];
      const truncated = allRows.length > limit;
      return {
        dialect: "mysql",
        database: (conn as any).config?.database || undefined,
        rowCount: allRows.length,
        columns: Array.isArray(fields) ? fields.map((f: any) => f.name) : (allRows.length > 0 ? Object.keys(allRows[0]) : []),
        rows: truncated ? allRows.slice(0, limit) : allRows,
        durationMs,
        truncated,
      };
    }

    const header = rows as any;
    return {
      dialect: "mysql",
      database: (conn as any).config?.database || undefined,
      rowCount: header.affectedRows || 0,
      durationMs,
      command: "AFFECTED",
    };
  } finally {
    await conn.end().catch(() => {});
  }
}

async function executeSqliteQuery(
  connectionString: string,
  sql: string,
  limit: number = 100,
): Promise<QueryExecutionResult> {
  const dbPath = connectionString.replace(/^sqlite:\/\//, "").replace(/^file:/, "") || ":memory:";
  const sqliteMod = await import("node:sqlite");
  const db = new sqliteMod.DatabaseSync(dbPath);
  try {
    const start = Date.now();
    const isSelect = /^\s*(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(sql);
    if (isSelect) {
      const stmt = db.prepare(sql);
      const allRows = stmt.all() as Record<string, unknown>[];
      const durationMs = Date.now() - start;
      const truncated = allRows.length > limit;
      return {
        dialect: "sqlite",
        database: dbPath,
        rowCount: allRows.length,
        columns: allRows.length > 0 ? Object.keys(allRows[0]) : [],
        rows: truncated ? allRows.slice(0, limit) : allRows,
        durationMs,
        truncated,
        command: "SELECT",
      };
    } else {
      const stmt = db.prepare(sql);
      const result = stmt.run() as any;
      const durationMs = Date.now() - start;
      return {
        dialect: "sqlite",
        database: dbPath,
        rowCount: result.changes || 0,
        durationMs,
        command: "EXECUTE",
      };
    }
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------ *
 * Register Tools
 * ------------------------------------------------------------------ */

export function registerSqlTools(server: McpServer): void {
  /* 1. Retrieve Schema Tool */
  server.registerTool(
    "sql_get_schema",
    {
      title: "Get Database Schema",
      description:
        "Retrieve database tables, views, columns, data types, primary keys, and foreign keys for the connected SQL database (PostgreSQL, MySQL, SQLite).",
      annotations: { title: "Get Database Schema", readOnlyHint: true },
      inputSchema: {
        connectionString: z
          .string()
          .optional()
          .describe("Optional database connection URI. If omitted, uses the stored database connection."),
        schema: z
          .string()
          .optional()
          .describe("Optional schema name to filter (e.g. 'public'). Defaults to 'public' for PostgreSQL."),
        tables: z
          .array(z.string())
          .optional()
          .describe("Optional array of specific table or view names to inspect."),
      },
    },
    guarded(async ({ connectionString, schema, tables }: { connectionString?: string; schema?: string; tables?: string[] }) => {
      const conn = connectionString?.trim() || (await readSqlConnectionString());
      if (!conn) {
        throw new RepoContextError(
          "No SQL database connection configured. Please save a database connection in Credentials or provide connectionString.",
        );
      }

      const validation = await validateSqlConnection(conn);
      if (!validation.valid) {
        throw new RepoContextError(`Invalid database connection string: ${validation.reason}`);
      }

      const dialect = validation.dialect || "postgresql";
      let schemaResult: DatabaseSchemaResult;

      try {
        if (dialect === "postgres" || dialect === "postgresql" || dialect === "cockroachdb") {
          schemaResult = await getPostgresSchema(conn, schema, tables);
        } else if (dialect === "mysql" || dialect === "mariadb") {
          schemaResult = await getMysqlSchema(conn, schema, tables);
        } else if (dialect === "sqlite") {
          schemaResult = await getSqliteSchema(conn, tables);
        } else {
          // Fallback to postgres
          schemaResult = await getPostgresSchema(conn, schema, tables);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new RepoContextError(`Failed to extract schema from ${dialect} database: ${msg}`);
      }

      return text({
        status: "ok",
        ...schemaResult,
      });
    }),
  );

  /* 2. Execute Query Tool */
  server.registerTool(
    "sql_execute_query",
    {
      title: "Execute SQL Query",
      description:
        "Execute a SQL query generated by the agent against the connected database and return structured results, affected rows, and execution duration.",
      annotations: { title: "Execute SQL Query", readOnlyHint: false },
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("The SQL query string to execute against the database (e.g. 'SELECT * FROM users LIMIT 10;')."),
        connectionString: z
          .string()
          .optional()
          .describe("Optional database connection URI. If omitted, uses the stored database connection."),
        limit: z
          .number()
          .optional()
          .describe("Maximum number of rows to return in the response (default: 100, max: 1000)."),
      },
    },
    guarded(async ({ query, connectionString, limit = 100 }: { query: string; connectionString?: string; limit?: number }) => {
      const conn = connectionString?.trim() || (await readSqlConnectionString());
      if (!conn) {
        throw new RepoContextError(
          "No SQL database connection configured. Please save a database connection in Credentials or provide connectionString.",
        );
      }

      const validation = await validateSqlConnection(conn);
      if (!validation.valid) {
        throw new RepoContextError(`Invalid database connection string: ${validation.reason}`);
      }

      const effectiveLimit = Math.min(Math.max(1, limit), 1000);
      const dialect = validation.dialect || "postgresql";
      let queryResult: QueryExecutionResult;

      try {
        if (dialect === "postgres" || dialect === "postgresql" || dialect === "cockroachdb") {
          queryResult = await executePostgresQuery(conn, query, effectiveLimit);
        } else if (dialect === "mysql" || dialect === "mariadb") {
          queryResult = await executeMysqlQuery(conn, query, effectiveLimit);
        } else if (dialect === "sqlite") {
          queryResult = await executeSqliteQuery(conn, query, effectiveLimit);
        } else {
          queryResult = await executePostgresQuery(conn, query, effectiveLimit);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new RepoContextError(`SQL Execution Error on ${dialect}: ${msg}`);
      }

      return text({
        status: "ok",
        ...queryResult,
      });
    }),
  );

  /* 3. Check Connection Tool */
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

  /* 4. Save SQL Config Tool */
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

  /* 5. Disconnect Tool */
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

