/**
 * DevToolbar
 *
 * Minimal floating devtools. Small pill bottom-end corner.
 * Opens into a bottom panel with Database, Logs, and Network tabs.
 * Only renders when VITE_STAGING env var is set to "true".
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { getPlatform } from "@/platform";
import type { Engine } from "@/platform/engine";
import type { ConnectionState, Peer } from "@/platform/types";
import type { DbRow } from "@/platform/driver";
import {
  getNetLogs,
  clearNetLogs,
  onNetLogsChange,
  type NetDirection,
} from "@/platform/devlog";
import { cn } from "@/lib/utils";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { motion, AnimatePresence } from "framer-motion";

const isStaging = import.meta.env.VITE_STAGING === "true";

type Tab = "database" | "logs" | "network" | "crdt" | "peers";
type DbView = "tables" | "query";

type QueryResult =
  | { ok: true; columns: string[]; rows: DbRow[]; time: number }
  | { ok: false; error: string };

// ─── SQL query helpers ──────────────────────────────────────────────────────

const SQL_HISTORY_MAX = 50;

async function executeQuery(sql: string): Promise<QueryResult> {
  const db = getDb();
  const trimmed = sql.trim();
  if (!trimmed) return { ok: false, error: "Empty query" };

  const t0 = performance.now();
  try {
    const isRead = /^\s*(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(trimmed);
    if (isRead) {
      const rows = await db.execute(trimmed);
      const time = performance.now() - t0;
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      return { ok: true, columns, rows, time };
    } else {
      const result = await db.run(trimmed);
      const time = performance.now() - t0;
      return {
        ok: true,
        columns: ["changes", "lastInsertRowId"],
        rows: [
          {
            changes: result.changes,
            lastInsertRowId: result.lastInsertRowId ?? null,
          },
        ],
        time,
      };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── SQL Keywords for basic highlighting ────────────────────────────────────

const SQL_KEYWORDS = new Set([
  "SELECT",
  "FROM",
  "WHERE",
  "AND",
  "OR",
  "NOT",
  "IN",
  "IS",
  "NULL",
  "INSERT",
  "INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE",
  "CREATE",
  "DROP",
  "ALTER",
  "TABLE",
  "INDEX",
  "VIEW",
  "AS",
  "ON",
  "JOIN",
  "LEFT",
  "RIGHT",
  "INNER",
  "OUTER",
  "CROSS",
  "GROUP",
  "BY",
  "ORDER",
  "ASC",
  "DESC",
  "LIMIT",
  "OFFSET",
  "HAVING",
  "UNION",
  "ALL",
  "DISTINCT",
  "EXISTS",
  "BETWEEN",
  "LIKE",
  "GLOB",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "CAST",
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "PRAGMA",
  "EXPLAIN",
  "WITH",
  "RECURSIVE",
  "REPLACE",
  "CONFLICT",
  "ABORT",
  "ROLLBACK",
  "BEGIN",
  "COMMIT",
  "TRANSACTION",
  "PRIMARY",
  "KEY",
  "FOREIGN",
  "REFERENCES",
  "DEFAULT",
  "CHECK",
  "UNIQUE",
  "AUTOINCREMENT",
  "IF",
  "COALESCE",
  "NULLIF",
  "TYPEOF",
  "LENGTH",
  "SUBSTR",
  "TRIM",
  "UPPER",
  "LOWER",
  "ABS",
  "ROUND",
  "RANDOM",
  "TRUE",
  "FALSE",
]);

// ─── Console log capture ─────────────────────────────────────────────────────

type LogLevel = "log" | "info" | "warn" | "error" | "debug";

interface LogEntry {
  id: number;
  level: LogLevel;
  message: string;
  timestamp: number;
}

const LOG_LEVELS: LogLevel[] = ["log", "info", "warn", "error", "debug"];
const LOG_MAX = 500;

let _logId = 0;
let _logs: LogEntry[] = [];
let _logListeners = new Set<() => void>();

function pushLog(level: LogLevel, args: unknown[]) {
  const message = args
    .map((a) => {
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
  _logs.push({ id: ++_logId, level, message, timestamp: Date.now() });
  if (_logs.length > LOG_MAX) _logs = _logs.slice(-LOG_MAX);
  _logListeners.forEach((fn) => fn());
}

if (isStaging && !(globalThis as any).__devtoolPatched) {
  (globalThis as any).__devtoolPatched = true;
  for (const level of LOG_LEVELS) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      pushLog(level, args);
    };
  }
}

function useLogs() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    _logListeners.add(fn);
    return () => {
      _logListeners.delete(fn);
    };
  }, []);
  return _logs;
}

function clearConsoleLogs() {
  _logs = [];
  _logListeners.forEach((fn) => fn());
}

// ─── Network logs hook ───────────────────────────────────────────────────────

function useNetLogs() {
  const [, setTick] = useState(0);
  useEffect(() => onNetLogsChange(() => setTick((t) => t + 1)), []);
  return getNetLogs();
}

// ─── Database helpers ────────────────────────────────────────────────────────

const TABLES = [
  "identity",
  "peers",
  "spaces",
  "space_members",
  "pages",
  "ops",
] as const;
type TableName = (typeof TABLES)[number];

const PAGE_SIZE = 50;

type ColType =
  | "text"
  | "integer"
  | "real"
  | "boolean"
  | "blob"
  | "json"
  | "datetime";

interface ColMeta {
  name: string;
  type: ColType;
  notnull: boolean;
}

interface TableInfo {
  columns: string[];
  colMeta: Record<string, ColMeta>;
  rows: DbRow[];
  total: number;
  pk: string[];
}

interface EditingCell {
  rowIdx: number;
  col: string;
  value: string;
  expanded: boolean; // for JSON/long text
}

/** Classify a SQLite declared type into our ColType */
function classifyType(declared: string): ColType {
  const t = declared.toUpperCase();
  if (/BOOL/.test(t)) return "boolean";
  if (/INT/.test(t)) return "integer";
  if (/REAL|FLOAT|DOUBLE|NUMERIC|DECIMAL/.test(t)) return "real";
  if (/BLOB/.test(t)) return "blob";
  if (/JSON/.test(t)) return "json";
  if (/DATE|TIME|TIMESTAMP/.test(t)) return "datetime";
  if (/CHAR|CLOB|TEXT|VARCHAR/.test(t)) return "text";
  return "text";
}

/** Short label for column type badge */
const TYPE_BADGE: Record<ColType, { label: string; color: string }> = {
  text: { label: "Abc", color: "text-emerald-400" },
  integer: { label: "123", color: "text-blue-400" },
  real: { label: "1.0", color: "text-sky-400" },
  boolean: { label: "T/F", color: "text-amber-400" },
  blob: { label: "Bin", color: "text-muted-foreground" },
  json: { label: "{ }", color: "text-violet-400" },
  datetime: { label: "Cal", color: "text-orange-400" },
};

function getDb() {
  return (getPlatform() as unknown as Engine).getDb();
}

async function fetchTable(
  table: TableName,
  offset: number,
  search: string,
): Promise<TableInfo> {
  const db = getDb();
  const pragma = await db.execute<{
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }>(`PRAGMA table_info("${table}")`);
  const columns = pragma.map((r) => r.name);
  const pk = pragma.filter((r) => r.pk > 0).map((r) => r.name);

  // Build column metadata map
  const colMeta: Record<string, ColMeta> = {};
  for (const r of pragma) {
    colMeta[r.name] = {
      name: r.name,
      type: classifyType(r.type),
      notnull: r.notnull === 1,
    };
  }

  let where = "";
  const params: unknown[] = [];
  if (search) {
    const cols = columns.filter((c) => c !== "data");
    if (cols.length) {
      where =
        "WHERE " + cols.map((c) => `CAST("${c}" AS TEXT) LIKE ?`).join(" OR ");
      cols.forEach(() => params.push(`%${search}%`));
    }
  }

  const [{ cnt }] = await db.execute<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM "${table}" ${where}`,
    params,
  );
  const selectCols = pk.length === 0 ? `rowid, *` : `*`;
  const rows = await db.execute(
    `SELECT ${selectCols} FROM "${table}" ${where} LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, offset],
  );
  const finalColumns =
    pk.length === 0 && !columns.includes("rowid")
      ? ["rowid", ...columns]
      : columns;
  const finalPk = pk.length > 0 ? pk : ["rowid"];
  // Add rowid meta if needed
  if (pk.length === 0 && !colMeta["rowid"]) {
    colMeta["rowid"] = { name: "rowid", type: "integer", notnull: true };
  }
  return { columns: finalColumns, colMeta, rows, total: cnt ?? 0, pk: finalPk };
}

function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (v instanceof Uint8Array) return `<${v.byteLength}B>`;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

function fmtBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / (1024 * 1024)).toFixed(1)}MB`;
}

function fmtRelTime(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return (
    d.toLocaleTimeString("en-GB", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }) +
    "." +
    String(d.getMilliseconds()).padStart(3, "0")
  );
}

const LEVEL_COLORS: Record<LogLevel, string> = {
  log: "text-foreground",
  info: "text-blue-400",
  warn: "text-amber-400",
  error: "text-red-400",
  debug: "text-muted-foreground",
};

const DIR_STYLE: Record<NetDirection, { label: string; color: string }> = {
  send: { label: "OUT", color: "text-blue-400" },
  recv: { label: "IN", color: "text-emerald-400" },
};

// ─── CRDT ops viewer ────────────────────────────────────────────────────

interface CrdtOpEntry {
  id: number;
  scopeId: string;
  peerId: string;
  clock: number;
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
}

const CRDT_OP_TYPES = [
  "text_insert",
  "text_delete",
  "mark_set",
  "block_insert",
  "block_delete",
  "block_set",
  "space_set",
  "member_add",
  "member_set",
  "member_remove",
  "page_add",
  "page_remove",
  "page_set",
];

const OP_TYPE_COLORS: Record<string, string> = {
  text_insert: "text-emerald-400",
  text_delete: "text-red-400",
  mark_set: "text-purple-400",
  block_insert: "text-blue-400",
  block_delete: "text-red-400",
  block_set: "text-amber-400",
  space_set: "text-cyan-400",
  member_add: "text-emerald-400",
  member_set: "text-amber-400",
  member_remove: "text-red-400",
  page_add: "text-emerald-400",
  page_remove: "text-red-400",
  page_set: "text-amber-400",
};

const CRDT_VIEW_LIMIT = 200;

function buildCrdtWhere(pageId: string, opType: string) {
  const params: unknown[] = [];
  const conditions: string[] = [];
  if (pageId !== "all") {
    conditions.push("scope_id = ?");
    params.push(pageId);
  }
  if (opType !== "all") {
    conditions.push("type = ?");
    params.push(opType);
  }
  const where = conditions.length > 0 ? " WHERE " + conditions.join(" AND ") : "";
  return { where, params };
}

async function fetchCrdtOpCount(
  pageId: string,
  opType: string,
): Promise<number> {
  const db = getDb();
  const { where, params } = buildCrdtWhere(pageId, opType);
  const [{ cnt }] = await db.execute<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM ops${where}`,
    params,
  );
  return cnt;
}

async function fetchCrdtOps(
  pageId: string,
  opType: string,
  limit: number = CRDT_VIEW_LIMIT,
): Promise<CrdtOpEntry[]> {
  const db = getDb();
  const { where, params } = buildCrdtWhere(pageId, opType);
  const query =
    "SELECT id, scope_id, peer_id, clock, type, data, timestamp FROM ops" +
    where +
    " ORDER BY timestamp DESC, clock DESC LIMIT ?";

  const rows = await db.execute(query, [...params, limit]);
  return rows.map((r: DbRow) => {
    let parsed: Record<string, unknown> = {};
    try {
      const raw = r.data;
      if (raw instanceof Uint8Array) {
        parsed = JSON.parse(new TextDecoder().decode(raw));
      } else if (typeof raw === "string") {
        parsed = JSON.parse(raw);
      }
    } catch {
      /* ignore */
    }
    return {
      id: r.id as number,
      scopeId: r.scope_id as string,
      peerId: r.peer_id as string,
      clock: r.clock as number,
      type: r.type as string,
      data: parsed,
      timestamp: r.timestamp as number,
    };
  });
}

async function fetchCrdtPages(): Promise<{ id: string; title: string }[]> {
  const db = getDb();
  const rows = await db.execute(
    "SELECT DISTINCT ops.scope_id as id, COALESCE(pages.title, ops.scope_id) as title FROM ops LEFT JOIN pages ON ops.scope_id = pages.id ORDER BY title",
  );
  return rows.map((r: DbRow) => ({
    id: r.id as string,
    title: r.title as string,
  }));
}

function crdtOpSummary(op: CrdtOpEntry): string {
  const d = op.data;
  switch (op.type) {
    case "text_insert": {
      const runs = d.charRuns as { text?: string }[] | undefined;
      const text = runs?.map((r) => r.text ?? "").join("") ?? "";
      return text.length > 40 ? `"${text.slice(0, 40)}..."` : `"${text}"`;
    }
    case "text_delete":
      return `${(d.charIds as string[])?.length ?? 0} chars`;
    case "mark_set":
      return `${d.format}=${String(d.value)} on ${(d.charIds as string[])?.length ?? 0} chars`;
    case "block_insert":
      return `${d.blockType} after ${d.afterBlockId ? String(d.afterBlockId).slice(0, 8) : "start"}`;
    case "block_delete":
      return String(d.blockId ?? "").slice(0, 16);
    case "block_set":
      return `${d.field}=${JSON.stringify(d.value)}`;
    case "space_set":
      return `${d.field}=${JSON.stringify(d.value)}`;
    case "member_add":
      return `${d.name} (${String(d.publicKey ?? "").slice(0, 8)}...)`;
    case "member_set":
      return `${d.field}=${JSON.stringify(d.value)} for ${String(d.publicKey ?? "").slice(0, 8)}...`;
    case "member_remove":
      return String(d.publicKey ?? "").slice(0, 16);
    case "page_add":
      return String(d.title ?? "untitled");
    case "page_remove":
      return String(d.pageId ?? "").slice(0, 16);
    case "page_set":
      return `${d.field}=${JSON.stringify(d.value)}`;
    default:
      return "";
  }
}

// ─── Cell renderer ──────────────────────────────────────────────────────

function CellEditor({ col, colType, nullable, editing, setEditing, saveEdit, row, typeColor }: {
  col: string; colType: ColType; nullable: boolean;
  editing: EditingCell; setEditing: (e: EditingCell | null) => void;
  saveEdit: (row: DbRow) => void; row: DbRow; typeColor: string;
}) {
  const isNum = colType === "integer" || colType === "real";

  // Boolean: inline toggle
  if (colType === "boolean") {
    const boolVal = editing.value === "1" || editing.value.toLowerCase() === "true";
    return (
      <div className="flex items-center gap-2">
        <button onClick={() => setEditing({ ...editing, value: boolVal ? "0" : "1" })} className={cn("relative w-6 h-3.5 rounded-full transition-colors shrink-0", boolVal ? "bg-emerald-500" : "bg-muted-foreground/30")}>
          <span className={cn("absolute top-[2px] w-2.5 h-2.5 rounded-full bg-white shadow-sm transition-transform", boolVal ? "translate-x-[10px]" : "translate-x-[2px]")} />
        </button>
        <span className={cn("text-[11px] font-medium", boolVal ? "text-emerald-400" : "text-muted-foreground/50")}>{boolVal ? "true" : "false"}</span>
        {nullable && <button onMouseDown={(e) => e.preventDefault()} onClick={() => { setEditing({ ...editing, value: "NULL" }); saveEdit(row); }} className="text-[9px] text-muted-foreground/30 hover:text-destructive font-mono transition-colors">null</button>}
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => saveEdit(row)} className="text-[9px] text-primary font-medium transition-colors">save</button>
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => setEditing(null)} className="text-[9px] text-muted-foreground/30 transition-colors">esc</button>
      </div>
    );
  }

  // JSON or expanded text: popover
  if (colType === "json" || editing.expanded) {
    return (
      <div className="absolute z-30 top-0 left-0 mt-[-1px] ml-[-1px]">
        <div className="bg-popover border border-border rounded-lg shadow-2xl overflow-hidden" style={{ minWidth: 320, maxWidth: 480 }}>
          <div className="flex items-center gap-2 px-2.5 h-7 border-b border-border bg-muted/30">
            <span className={cn("text-[10px] font-medium", typeColor)}>{col}</span>
            <span className="text-[9px] text-muted-foreground/40 font-mono">{colType}</span>
            <div className="flex-1" />
            {nullable && <button onMouseDown={(e) => e.preventDefault()} onClick={() => { setEditing({ ...editing, value: "NULL" }); saveEdit(row); }} className="text-[9px] text-muted-foreground/40 hover:text-destructive font-mono px-1 rounded hover:bg-muted transition-colors">NULL</button>}
          </div>
          <textarea
            autoFocus
            value={editing.value}
            onChange={(e) => setEditing({ ...editing, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveEdit(row); }
              if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
            }}
            spellCheck={false}
            className={cn("w-full min-h-[100px] max-h-[240px] px-2.5 py-2 font-mono text-[11px] leading-[1.5] bg-transparent resize-y focus:outline-none", typeColor)}
          />
          <div className="flex items-center gap-2 px-2.5 h-7 border-t border-border bg-muted/30">
            <span className="text-[9px] text-muted-foreground/30 font-mono">{navigator.platform.includes("Mac") ? "\u2318" : "Ctrl"}+\u21B5 save &middot; esc cancel</span>
            <div className="flex-1" />
            <button onMouseDown={(e) => e.preventDefault()} onClick={() => setEditing(null)} className="text-[10px] text-muted-foreground px-1.5 py-0.5 rounded hover:bg-muted transition-colors">Cancel</button>
            <button onMouseDown={(e) => e.preventDefault()} onClick={() => saveEdit(row)} className="text-[10px] text-primary-foreground bg-primary font-medium px-2 py-0.5 rounded hover:bg-primary/90 transition-colors">Save</button>
          </div>
        </div>
      </div>
    );
  }

  // All other: inline input matching cell dimensions
  return (
    <div className="flex items-center">
      <input
        autoFocus
        type="text"
        inputMode={colType === "integer" ? "numeric" : colType === "real" ? "decimal" : "text"}
        value={editing.value}
        onChange={(e) => setEditing({ ...editing, value: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); saveEdit(row); }
          if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
          if (e.key === "Tab") { e.preventDefault(); saveEdit(row); }
          if (e.key === "ArrowUp" && colType === "integer") { e.preventDefault(); const n = parseInt(editing.value, 10); if (!isNaN(n)) setEditing({ ...editing, value: String(n + 1) }); }
          if (e.key === "ArrowDown" && colType === "integer") { e.preventDefault(); const n = parseInt(editing.value, 10); if (!isNaN(n)) setEditing({ ...editing, value: String(n - 1) }); }
        }}
        onBlur={() => saveEdit(row)}
        className={cn(
          "w-full h-full px-2.5 py-0.5 bg-transparent font-mono text-[11px]",
          "ring-1 ring-inset ring-primary/40 focus:ring-primary rounded-sm",
          "focus:outline-none",
          isNum && "text-end tabular-nums",
          typeColor,
        )}
      />
      {nullable && <button onMouseDown={(e) => e.preventDefault()} onClick={() => { setEditing({ ...editing, value: "NULL" }); saveEdit(row); }} className="text-[9px] text-muted-foreground/30 hover:text-destructive font-mono px-1 shrink-0 transition-colors">null</button>}
      {colType === "text" && editing.value.length > 40 && <button onMouseDown={(e) => e.preventDefault()} onClick={() => setEditing({ ...editing, expanded: true })} className="text-muted-foreground/30 hover:text-foreground px-0.5 shrink-0 transition-colors"><svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5" /></svg></button>}
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

const PANEL_MIN_H = 200;
const PANEL_MAX_H_VH = 80; // percent of viewport
const PANEL_DEFAULT_H = 520;

export function DevToolbar() {
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [tab, setTab] = useState<Tab>("database");
  const [conn, setConn] = useState<ConnectionState>("disconnected");
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);
  const [connectedPeerNames, setConnectedPeerNames] = useState<string[]>([]);
  const [knownPeers, setKnownPeers] = useState<Peer[]>([]);
  const [panelHeight, setPanelHeight] = useState(() =>
    Math.min(PANEL_DEFAULT_H, Math.floor(window.innerHeight * (PANEL_MAX_H_VH / 100)))
  );
  const [isResizing, setIsResizing] = useState(false);

  // migrations
  const [pendingMigrations, setPendingMigrations] = useState(0);
  const [migrating, setMigrating] = useState(false);

  // database — tables view
  const [dbView, setDbView] = useState<DbView>("tables");
  const [table, setTable] = useState<TableName>("pages");
  const [info, setInfo] = useState<TableInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [input, setInput] = useState("");

  // database — inline edit & selection
  const [selected, setSelected] = useState<Set<string>>(new Set()); // set of serialised PK values
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const [deleting, setDeleting] = useState(false);

  // database — query view
  const [sql, setSql] = useState("SELECT * FROM pages LIMIT 20;");
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [queryRunning, setQueryRunning] = useState(false);
  const [sqlHistory, setSqlHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const sqlRef = useRef<HTMLTextAreaElement>(null);

  // console logs
  const logs = useLogs();
  const [logFilter, setLogFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState<LogLevel | "all">("all");
  const logEndRef = useRef<HTMLDivElement>(null);

  // network logs
  const netLogs = useNetLogs();
  const [netFilter, setNetFilter] = useState("");
  const [dirFilter, setDirFilter] = useState<NetDirection | "all">("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const netEndRef = useRef<HTMLDivElement>(null);

  // crdt ops
  const [crdtPageId, setCrdtPageId] = useState<string>("all");
  const [crdtOpType, setCrdtOpType] = useState<string>("all");
  const [crdtOps, setCrdtOps] = useState<CrdtOpEntry[]>([]);
  const [crdtPages, setCrdtPages] = useState<{ id: string; title: string }[]>(
    [],
  );
  const [crdtLoading, setCrdtLoading] = useState(false);
  const [crdtExpanded, setCrdtExpanded] = useState<number | null>(null);
  const [crdtFilter, setCrdtFilter] = useState("");
  const [crdtCopied, setCrdtCopied] = useState(false);
  // crdt export dialog
  const [crdtExportOpen, setCrdtExportOpen] = useState(false);
  const [crdtExportTotal, setCrdtExportTotal] = useState<number | null>(null);
  const [crdtExportLimit, setCrdtExportLimit] = useState("");
  const [crdtExporting, setCrdtExporting] = useState(false);
  const [logsCopied, setLogsCopied] = useState(false);
  const [netCopied, setNetCopied] = useState(false);
  const [queryCopied, setQueryCopied] = useState(false);

  // Set CSS variable so layout can shrink to make room
  useEffect(() => {
    const el = document.documentElement;
    if (open) {
      el.style.setProperty("--devtool-height", `${panelHeight}px`);
    } else {
      el.style.setProperty("--devtool-height", "0px");
    }
    return () => {
      el.style.setProperty("--devtool-height", "0px");
    };
  }, [open, panelHeight]);

  // Resize drag handler
  const onResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      setIsResizing(true);
      const startY = e.clientY;
      const startH = panelHeight;
      const maxH = window.innerHeight * (PANEL_MAX_H_VH / 100);

      const onMove = (ev: PointerEvent) => {
        const delta = startY - ev.clientY;
        const next = Math.min(maxH, Math.max(PANEL_MIN_H, startH + delta));
        setPanelHeight(next);
      };
      const onUp = () => {
        setIsResizing(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [panelHeight],
  );

  useEffect(() => {
    if (open && tab === "logs")
      logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs.length, open, tab]);

  useEffect(() => {
    if (open && tab === "network")
      netEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [netLogs.length, open, tab]);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    let unsubPeers: (() => void) | undefined;
    let active = true;
    try {
      const p = getPlatform();
      setConn(p.sync.getConnectionState());
      const hydratePeers = async (peerKeys: string[]) => {
        try {
          const knownPeers = await p.peers.list();
          if (!active) return;
          const nameByKey = new Map(
            knownPeers.map((peer) => [peer.publicKey, peer.name]),
          );
          setConnectedPeerNames(
            peerKeys.map(
              (key) =>
                nameByKey.get(key) || `${key.slice(0, 8)}...${key.slice(-4)}`,
            ),
          );
        } catch {
          if (!active) return;
          setConnectedPeerNames(
            peerKeys.map((key) => `${key.slice(0, 8)}...${key.slice(-4)}`),
          );
        }
      };

      const initialPeers = p.sync.getConnectedPeers();
      setConnectedPeers(initialPeers);
      void hydratePeers(initialPeers);

      unsub = p.sync.onConnectionChange(setConn);
      unsubPeers = p.sync.onConnectedPeersChange((peerKeys) => {
        setConnectedPeers(peerKeys);
        void hydratePeers(peerKeys);
      });
    } catch {
      /* not ready */
    }
    return () => {
      active = false;
      unsub?.();
      unsubPeers?.();
    };
  }, []);

  const load = useCallback(async (t: TableName, o: number, s: string) => {
    setLoading(true);
    try {
      setInfo(await fetchTable(t, o, s));
    } catch (e) {
      console.error("db:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && tab === "database" && dbView === "tables")
      load(table, offset, search);
  }, [open, tab, dbView, table, offset, search, load]);

  useEffect(() => {
    if (!open || tab !== "database") return;
    try {
      (getPlatform() as unknown as Engine).getPendingMigrations()
        .then(setPendingMigrations)
        .catch(() => {});
    } catch { /* not ready */ }
  }, [open, tab]);

  async function runMigrations() {
    setMigrating(true);
    try {
      await (getPlatform() as unknown as Engine).applyMigrations();
      setPendingMigrations(0);
    } catch { /* ignore */ } finally {
      setMigrating(false);
    }
  }

  useEffect(() => {
    if (!open || tab !== "peers") return;
    try {
      getPlatform().peers.list().then(setKnownPeers).catch(() => {});
    } catch { /* not ready */ }
  }, [open, tab]);

  const loadCrdtOps = useCallback(async () => {
    setCrdtLoading(true);
    try {
      const [ops, pages] = await Promise.all([
        fetchCrdtOps(crdtPageId, crdtOpType),
        fetchCrdtPages(),
      ]);
      setCrdtOps(ops);
      setCrdtPages(pages);
    } catch (e) {
      console.error("crdt:", e);
    } finally {
      setCrdtLoading(false);
    }
  }, [crdtPageId, crdtOpType]);

  useEffect(() => {
    if (open && tab === "crdt") loadCrdtOps();
  }, [open, tab, loadCrdtOps]);

  const getFilteredCrdtOps = useCallback(() => {
    return crdtOps.filter(
      (o) =>
        !crdtFilter ||
        crdtOpSummary(o).toLowerCase().includes(crdtFilter.toLowerCase()) ||
        o.peerId.toLowerCase().includes(crdtFilter.toLowerCase()),
    );
  }, [crdtOps, crdtFilter]);

  const copyCrdtOps = useCallback(async () => {
    const filtered = getFilteredCrdtOps();
    const json = JSON.stringify(
      filtered.map((o) => o.data),
      null,
      2,
    );
    await navigator.clipboard.writeText(json);
    setCrdtCopied(true);
    setTimeout(() => setCrdtCopied(false), 1500);
  }, [getFilteredCrdtOps]);

  const openCrdtExport = useCallback(async () => {
    setCrdtExportOpen(true);
    setCrdtExportTotal(null);
    try {
      const total = await fetchCrdtOpCount(crdtPageId, crdtOpType);
      setCrdtExportTotal(total);
      setCrdtExportLimit(String(total));
    } catch (e) {
      console.error("crdt count:", e);
      setCrdtExportTotal(0);
    }
  }, [crdtPageId, crdtOpType]);

  const runCrdtExport = useCallback(async () => {
    const limit = Math.max(1, Math.floor(Number(crdtExportLimit) || 0));
    if (!limit) return;
    setCrdtExporting(true);
    try {
      const ops = await fetchCrdtOps(crdtPageId, crdtOpType, limit);
      const filtered = ops.filter(
        (o) =>
          !crdtFilter ||
          crdtOpSummary(o).toLowerCase().includes(crdtFilter.toLowerCase()) ||
          o.peerId.toLowerCase().includes(crdtFilter.toLowerCase()),
      );
      const json = JSON.stringify(
        filtered.map((o) => o.data),
        null,
        2,
      );
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `crdt-ops-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setCrdtExportOpen(false);
    } catch (e) {
      console.error("crdt export:", e);
    } finally {
      setCrdtExporting(false);
    }
  }, [crdtExportLimit, crdtPageId, crdtOpType, crdtFilter]);

  const copyQueryResult = useCallback(async () => {
    if (!queryResult || !queryResult.ok) return;
    await navigator.clipboard.writeText(JSON.stringify(queryResult.rows, null, 2));
    setQueryCopied(true);
    setTimeout(() => setQueryCopied(false), 1500);
  }, [queryResult]);

  const exportQueryResult = useCallback(() => {
    if (!queryResult || !queryResult.ok) return;
    const json = JSON.stringify(queryResult.rows, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `query-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [queryResult]);

  const runQuery = useCallback(async () => {
    const trimmed = sql.trim();
    if (!trimmed || queryRunning) return;
    setQueryRunning(true);
    setQueryResult(null);
    try {
      const result = await executeQuery(trimmed);
      setQueryResult(result);
      // Add to history (dedup)
      setSqlHistory((prev) => {
        const filtered = prev.filter((s) => s !== trimmed);
        const next = [trimmed, ...filtered].slice(0, SQL_HISTORY_MAX);
        return next;
      });
      setHistoryIdx(-1);
    } finally {
      setQueryRunning(false);
    }
  }, [sql, queryRunning]);

  // Build a unique key for a row from its PK columns
  const rowKey = useCallback((row: DbRow, pk: string[]) => {
    return pk.map((c) => String(row[c] ?? "")).join("|");
  }, []);

  // Parse value based on column type
  const parseValue = useCallback((value: string, colType: ColType): unknown => {
    if (value === "NULL" || value === "null") return null;
    switch (colType) {
      case "boolean": {
        const l = value.toLowerCase();
        if (l === "true" || l === "1" || l === "yes") return 1;
        if (l === "false" || l === "0" || l === "no") return 0;
        return value;
      }
      case "integer": {
        const n = parseInt(value, 10);
        return isNaN(n) ? value : n;
      }
      case "real": {
        const n = parseFloat(value);
        return isNaN(n) ? value : n;
      }
      case "json":
        return value; // stored as text in SQLite
      case "datetime":
        return value;
      default:
        return value;
    }
  }, []);

  // Save an inline cell edit
  const saveEdit = useCallback(
    async (row: DbRow) => {
      if (!editing || !info) return;
      const db = getDb();
      const { col, value } = editing;
      const pkWhere = info.pk.map((c) => `"${c}" = ?`).join(" AND ");
      const pkValues = info.pk.map((c) => row[c]);
      const colType = info.colMeta[col]?.type ?? "text";
      const parsed = parseValue(value, colType);

      try {
        await db.run(`UPDATE "${table}" SET "${col}" = ? WHERE ${pkWhere}`, [
          parsed,
          ...pkValues,
        ]);
        load(table, offset, search);
      } catch (e) {
        console.error("inline edit failed:", e);
      }
      setEditing(null);
    },
    [editing, info, table, load, offset, search, parseValue],
  );

  // Delete selected rows
  const deleteSelected = useCallback(async () => {
    if (!info || selected.size === 0) return;
    setDeleting(true);
    const db = getDb();
    try {
      const pkWhere = info.pk.map((c) => `"${c}" = ?`).join(" AND ");
      for (const row of info.rows) {
        const key = rowKey(row, info.pk);
        if (!selected.has(key)) continue;
        const pkValues = info.pk.map((c) => row[c]);
        await db.run(`DELETE FROM "${table}" WHERE ${pkWhere}`, pkValues);
      }
      setSelected(new Set());
      load(table, offset, search);
    } catch (e) {
      console.error("delete failed:", e);
    } finally {
      setDeleting(false);
    }
  }, [info, selected, table, load, offset, search, rowKey]);

  const filteredLogs = logs.filter((l) => {
    if (levelFilter !== "all" && l.level !== levelFilter) return false;
    if (logFilter && !l.message.toLowerCase().includes(logFilter.toLowerCase()))
      return false;
    return true;
  });

  const filteredNet = netLogs.filter((l) => {
    if (dirFilter !== "all" && l.direction !== dirFilter) return false;
    if (typeFilter !== "all" && l.type !== typeFilter) return false;
    if (
      netFilter &&
      !l.summary.toLowerCase().includes(netFilter.toLowerCase()) &&
      !l.type.includes(netFilter.toLowerCase())
    )
      return false;
    return true;
  });

  const copyLogs = useCallback(async () => {
    const text = filteredLogs
      .map((l) => `[${fmtTime(l.timestamp)}] [${l.level}] ${l.message}`)
      .join("\n");
    await navigator.clipboard.writeText(text);
    setLogsCopied(true);
    setTimeout(() => setLogsCopied(false), 1500);
  }, [filteredLogs]);

  const exportLogs = useCallback(() => {
    const text = filteredLogs
      .map((l) => `[${fmtTime(l.timestamp)}] [${l.level}] ${l.message}`)
      .join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `logs-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredLogs]);

  const copyNetLogs = useCallback(async () => {
    const json = JSON.stringify(
      filteredNet.map((l) => ({
        time: fmtTime(l.timestamp),
        direction: l.direction,
        peer: l.peer,
        type: l.type,
        summary: l.summary,
        size: l.size,
      })),
      null,
      2,
    );
    await navigator.clipboard.writeText(json);
    setNetCopied(true);
    setTimeout(() => setNetCopied(false), 1500);
  }, [filteredNet]);

  const exportNetLogs = useCallback(() => {
    const json = JSON.stringify(
      filteredNet.map((l) => ({
        time: fmtTime(l.timestamp),
        direction: l.direction,
        peer: l.peer,
        type: l.type,
        summary: l.summary,
        size: l.size,
      })),
      null,
      2,
    );
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `network-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredNet]);

  if (!isStaging || hidden) return null;

  const selectTable = (t: TableName) => {
    setTable(t);
    setOffset(0);
    setSearch("");
    setInput("");
    setDbView("tables");
    setSelected(new Set());
    setEditing(null);
  };
  const totalPages = info ? Math.ceil(info.total / PAGE_SIZE) : 0;
  const page = Math.floor(offset / PAGE_SIZE) + 1;

  // Tab content fade animation
  const tabMotion = {
    initial: { opacity: 0, y: 3 } as const,
    animate: { opacity: 1, y: 0 } as const,
    transition: { duration: 0.1 } as const,
  };

  // Get unique message types for the filter
  const msgTypes = [...new Set(netLogs.map((l) => l.type))].sort();

  // ─── Render ────────────────────────────────────────────────────────────────

  const peersSummary =
    connectedPeerNames.length > 0
      ? connectedPeerNames.join(", ")
      : "No peers connected";

  return (
    <AnimatePresence mode="wait">
      {open ? (
        <motion.div
          key="panel"
          initial={{ y: 24, opacity: 0, scale: 0.98 }}
          animate={{ y: 0, opacity: 1, scale: 1 }}
          exit={{ y: 24, opacity: 0, scale: 0.98 }}
          transition={{ type: "spring", damping: 30, stiffness: 500 }}
          style={{ height: panelHeight, maxHeight: `${PANEL_MAX_H_VH}vh` }}
          className={cn(
            "fixed inset-x-0 bottom-0 z-40 top-auto",
            "bg-popover/95 backdrop-blur-xl",
            "border-t border-border",
            "shadow-2xl",
            "font-sans",
            "flex flex-col overflow-hidden",
          )}
        >
          {/* Resize handle */}
          <div
            onPointerDown={onResizePointerDown}
            className="shrink-0 h-1.5 cursor-ns-resize flex items-center justify-center hover:bg-muted/50 transition-colors group"
          >
            <div className="w-8 h-0.5 rounded-full bg-border group-hover:bg-muted-foreground transition-colors" />
          </div>
          {/* Top bar */}
          <div className="flex items-center h-7 px-1.5 border-b border-border shrink-0 gap-0.5">
            <button
              onClick={() => setOpen(false)}
              className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            <div className="w-px h-3 bg-border shrink-0 mx-0.5" />

            <div className="flex items-center gap-0.5 overflow-x-auto no-scrollbar min-w-0 flex-1">
              {(["database", "logs", "network", "crdt", "peers"] as Tab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={cn(
                    "relative px-2 py-px rounded text-[10px] capitalize transition-colors whitespace-nowrap shrink-0",
                    tab === t
                      ? "text-background font-medium"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted",
                  )}
                >
                  {tab === t && (
                    <motion.span
                      layoutId={isResizing ? undefined : "devtool-tab"}
                      className="absolute inset-0 bg-foreground rounded"
                      transition={{ type: "spring", damping: 30, stiffness: 500 }}
                    />
                  )}
                  <span className="relative z-10">{t}</span>
                </button>
              ))}
            </div>

            <button
              onClick={() => setTab("peers")}
              className={cn(
                "flex items-center gap-0.5 h-5 px-1 rounded transition-colors shrink-0",
                "border border-border/70",
                tab === "peers" ? "bg-muted text-foreground" : "bg-muted/40 text-muted-foreground hover:text-foreground hover:bg-muted",
              )}
              title={peersSummary}
            >
              <svg className="w-2.5 h-2.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 20a4 4 0 00-8 0m8 0H7m10 0h3m-3 0a4 4 0 00-8 0m-5 0h3m0 0a4 4 0 018 0m0-8a3 3 0 11-6 0 3 3 0 016 0zm6 1a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zM8 13a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z" />
              </svg>
              <span className="text-[10px] font-medium tabular-nums">{connectedPeers.length}</span>
            </button>

            <div className="flex items-center gap-1 px-1.5 shrink-0">
              <div
                className={cn(
                  "w-1.5 h-1.5 rounded-full",
                  conn === "connected"
                    ? "bg-emerald-500"
                    : conn === "connecting"
                      ? "bg-amber-500"
                      : "bg-red-500",
                )}
              />
            </div>
          </div>

          {/* ── Database tab ── */}
          {tab === "database" && (
            <motion.div
              key="db"
              {...tabMotion}
              className="flex flex-col flex-1 min-h-0"
            >
              {/* View toggle: Tables | Query */}
              <div className="flex items-center h-8 px-2 border-b border-border shrink-0 gap-1.5">
                {(["tables", "query"] as DbView[]).map((v) => (
                  <button
                    key={v}
                    onClick={() => setDbView(v)}
                    className={cn(
                      "px-2 py-0.5 rounded text-[11px] capitalize transition-colors",
                      dbView === v
                        ? "bg-muted text-foreground font-medium"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {v}
                  </button>
                ))}

                {/* Tables sub-header (table tabs + search) */}
                {dbView === "tables" && (
                  <>
                    <div className="w-px h-3.5 bg-border shrink-0" />
                    <div className="flex items-center gap-0.5 min-w-0 overflow-x-auto no-scrollbar">
                      {TABLES.map((t) => (
                        <button
                          key={t}
                          onClick={() => selectTable(t)}
                          className={cn(
                            "px-2 py-0.5 rounded text-[11px] whitespace-nowrap transition-colors",
                            table === t
                              ? "bg-muted text-foreground font-medium"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                    <div className="w-px h-3.5 bg-border shrink-0" />
                    <div className="relative flex items-center flex-1 max-w-[200px]">
                      <svg
                        className="absolute start-2 w-3 h-3 text-muted-foreground pointer-events-none"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                        />
                      </svg>
                      <input
                        type="text"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            setOffset(0);
                            setSearch(input);
                          }
                        }}
                        placeholder="Filter..."
                        className="h-5 w-full ps-7 pe-5 text-[11px] rounded bg-transparent text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
                      />
                      {input && (
                        <button
                          onClick={() => {
                            setInput("");
                            setSearch("");
                            setOffset(0);
                          }}
                          className="absolute end-1 text-muted-foreground hover:text-foreground"
                        >
                          <svg
                            className="w-3 h-3"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M6 18L18 6M6 6l12 12"
                            />
                          </svg>
                        </button>
                      )}
                    </div>
                    <button
                      onClick={() => load(table, offset, search)}
                      className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
                    >
                      <svg
                        className={cn("w-3 h-3", loading && "animate-spin")}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                        />
                      </svg>
                    </button>
                    {info && (
                      <span className="text-[10px] text-muted-foreground tabular-nums whitespace-nowrap shrink-0">
                        {info.total}
                      </span>
                    )}
                    {selected.size > 0 && (
                      <>
                        <div className="w-px h-3.5 bg-border shrink-0" />
                        <button
                          onClick={deleteSelected}
                          disabled={deleting}
                          className={cn(
                            "h-5 px-2 flex items-center gap-1 rounded text-[10px] font-medium transition-colors",
                            "bg-destructive/10 text-destructive hover:bg-destructive/20",
                            "disabled:opacity-40 disabled:pointer-events-none",
                          )}
                        >
                          <svg
                            className="w-3 h-3"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                            />
                          </svg>
                          Delete {selected.size}
                        </button>
                      </>
                    )}
                  </>
                )}

                {/* Query sub-header (run + status) */}
                {dbView === "query" && (
                  <>
                    <div className="w-px h-3.5 bg-border shrink-0" />
                    <button
                      onClick={runQuery}
                      disabled={queryRunning || !sql.trim()}
                      className={cn(
                        "h-5 px-2.5 flex items-center gap-1.5 rounded text-[11px] font-medium transition-colors",
                        "bg-primary text-primary-foreground hover:bg-primary/90",
                        "disabled:opacity-40 disabled:pointer-events-none",
                      )}
                    >
                      {queryRunning ? (
                        <svg
                          className="w-3 h-3 animate-spin"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                          />
                        </svg>
                      ) : (
                        <svg
                          className="w-3 h-3"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M5 3l14 9-14 9V3z"
                          />
                        </svg>
                      )}
                      Run
                    </button>
                    <span className="text-[10px] text-muted-foreground/50">
                      {navigator.platform.includes("Mac") ? "\u2318" : "Ctrl"}
                      +Enter
                    </span>
                    <div className="flex-1" />
                    {queryResult && queryResult.ok && (
                      <>
                        <span className="text-[10px] text-muted-foreground tabular-nums">
                          {queryResult.rows.length} row
                          {queryResult.rows.length !== 1 ? "s" : ""} in{" "}
                          {queryResult.time.toFixed(1)}ms
                        </span>
                        <button
                          onClick={copyQueryResult}
                          className="h-5 px-1.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                        >
                          {queryCopied ? "Copied!" : "Copy"}
                        </button>
                        <button
                          onClick={exportQueryResult}
                          className="h-5 px-1.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                        >
                          Export
                        </button>
                      </>
                    )}
                    {sqlHistory.length > 0 && (
                      <button
                        onClick={() => {
                          setSqlHistory([]);
                          setHistoryIdx(-1);
                        }}
                        className="h-5 px-1.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                      >
                        Clear history
                      </button>
                    )}
                  </>
                )}
              </div>

              {/* ── Migration banner ── */}
              {pendingMigrations > 0 && (
                <div className="flex items-center gap-2 px-3 py-1.5 bg-yellow-500/10 border-b border-yellow-500/20 text-yellow-600 dark:text-yellow-400 shrink-0">
                  <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                  </svg>
                  <span className="text-[11px] flex-1">
                    {pendingMigrations} pending migration{pendingMigrations !== 1 ? "s" : ""}
                  </span>
                  <button
                    onClick={runMigrations}
                    disabled={migrating}
                    className={cn(
                      "h-5 px-2.5 rounded text-[10px] font-medium transition-colors",
                      "bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-700 dark:text-yellow-300",
                      "disabled:opacity-40 disabled:pointer-events-none",
                    )}
                  >
                    {migrating ? "Applying..." : "Apply"}
                  </button>
                </div>
              )}

              {/* ── Tables view ── */}
              {dbView === "tables" && (
                <>
                  <ScrollArea className="flex-1 min-h-0">
                    <div className="min-w-max">
                      {info && info.columns.length > 0 && (
                        <table className="w-full">
                          <thead className="sticky top-0 z-10">
                            <tr className="bg-muted/50 backdrop-blur-sm">
                              <th className="px-1.5 py-1 border-b border-border w-7">
                                <input
                                  type="checkbox"
                                  checked={
                                    info.rows.length > 0 &&
                                    info.rows.every((r) =>
                                      selected.has(rowKey(r, info.pk)),
                                    )
                                  }
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setSelected(
                                        new Set(
                                          info.rows.map((r) =>
                                            rowKey(r, info.pk),
                                          ),
                                        ),
                                      );
                                    } else {
                                      setSelected(new Set());
                                    }
                                  }}
                                  className="w-3 h-3 rounded accent-primary cursor-pointer"
                                />
                              </th>
                              <th className="px-2.5 py-1 text-start text-[10px] font-medium text-muted-foreground uppercase tracking-wider w-8 border-b border-border">
                                #
                              </th>
                              {info.columns.map((col) => {
                                const meta = info.colMeta[col];
                                const badge = meta
                                  ? TYPE_BADGE[meta.type]
                                  : null;
                                return (
                                  <th
                                    key={col}
                                    className="px-2.5 py-1 text-start text-[10px] font-medium text-muted-foreground border-b border-border"
                                  >
                                    <div className="flex items-center gap-1.5">
                                      <span className="uppercase tracking-wider">
                                        {col}
                                      </span>
                                      {badge && (
                                        <span
                                          className={cn(
                                            "text-[9px] font-mono font-normal opacity-60",
                                            badge.color,
                                          )}
                                        >
                                          {badge.label}
                                        </span>
                                      )}
                                      {info.pk.includes(col) && (
                                        <span className="text-[8px] font-mono font-semibold text-amber-400/70">
                                          PK
                                        </span>
                                      )}
                                    </div>
                                  </th>
                                );
                              })}
                            </tr>
                          </thead>
                          <tbody>
                            {info.rows.map((row, i) => {
                              const key = rowKey(row, info.pk);
                              const isSelected = selected.has(key);
                              return (
                                <tr
                                  key={i}
                                  className={cn(
                                    "border-b border-border/30 hover:bg-muted/20 transition-colors",
                                    isSelected && "bg-primary/5",
                                  )}
                                >
                                  <td className="px-1.5 py-0.5">
                                    <input
                                      type="checkbox"
                                      checked={isSelected}
                                      onChange={() => {
                                        setSelected((prev) => {
                                          const next = new Set(prev);
                                          if (next.has(key)) next.delete(key);
                                          else next.add(key);
                                          return next;
                                        });
                                      }}
                                      className="w-3 h-3 rounded accent-primary cursor-pointer"
                                    />
                                  </td>
                                  <td className="px-2.5 py-0.5 text-[10px] text-muted-foreground/50 font-mono tabular-nums">
                                    {offset + i + 1}
                                  </td>
                                  {info.columns.map((col) => {
                                    const v = row[col];
                                    const isNull = v === null || v === undefined;
                                    const cellEditing = editing?.rowIdx === i && editing?.col === col;
                                    const isBinary = v instanceof Uint8Array;
                                    const isPk = info.pk.includes(col);
                                    const meta = info.colMeta[col];
                                    const colType = meta?.type ?? "text" as ColType;
                                    const canEdit = !isPk && !isBinary;
                                    const nullable = !meta?.notnull;
                                    const isNum = colType === "integer" || colType === "real";
                                    const typeColor = isNum ? "text-blue-400" : colType === "boolean" ? "text-amber-400" : colType === "json" ? "text-violet-400" : colType === "datetime" ? "text-orange-400" : "text-foreground";

                                    const startEdit = () => {
                                      if (!canEdit) return;
                                      const editVal = isNull ? "NULL" : colType === "json" && typeof v === "object" ? JSON.stringify(v, null, 2) : colType === "boolean" ? (v === 1 || v === true || v === "1" || v === "true" ? "1" : "0") : String(v);
                                      setEditing({ rowIdx: i, col, value: editVal, expanded: false });
                                    };

                                    const displayStr = isBinary ? `<${(v as Uint8Array).byteLength}B>` : isNull ? "NULL" : colType === "json" && typeof v === "object" ? JSON.stringify(v) : colType === "boolean" ? (v === 1 || v === true || v === "1" || v === "true" ? "true" : "false") : String(v);

                                    // Editing mode
                                    if (cellEditing && editing) {
                                      const isExpanded = colType === "json" || editing.expanded;
                                      return (
                                        <td key={col} className={cn("px-2.5 py-0.5 font-mono text-[11px]", isNum && !isExpanded && "text-end", isExpanded && "relative")}>
                                          <CellEditor col={col} colType={colType} nullable={nullable} editing={editing} setEditing={setEditing} saveEdit={saveEdit} row={row} typeColor={typeColor} />
                                          {isExpanded && <span className={cn("truncate block max-w-[200px] opacity-20", typeColor)}>{displayStr}</span>}
                                        </td>
                                      );
                                    }

                                    // Display: NULL
                                    if (isNull) return <td key={col} className={cn("px-2.5 py-0.5 font-mono text-[11px]", canEdit && "cursor-text group/cell")} onDoubleClick={startEdit}><span className="text-muted-foreground/30 italic text-[10px] group-hover/cell:text-muted-foreground/50 transition-colors">NULL</span></td>;

                                    // Display: boolean
                                    if (colType === "boolean") {
                                      const boolVal = v === 1 || v === true || v === "1" || v === "true";
                                      return <td key={col} className={cn("px-2.5 py-0.5 font-mono text-[11px]", canEdit && "cursor-pointer")} onDoubleClick={startEdit}><span className={cn("inline-flex items-center gap-1", boolVal ? "text-emerald-400" : "text-muted-foreground/50")}><span className={cn("w-1.5 h-1.5 rounded-full shrink-0", boolVal ? "bg-emerald-400" : "bg-muted-foreground/25")} />{boolVal ? "true" : "false"}</span></td>;
                                    }

                                    // Display: binary
                                    if (isBinary) return <td key={col} className="px-2.5 py-0.5 font-mono text-[11px]"><span className="text-muted-foreground/40">&lt;{(v as Uint8Array).byteLength}B&gt;</span></td>;

                                    // Display: all other types
                                    return <td key={col} className={cn("px-2.5 py-0.5 font-mono text-[11px]", isNum && "text-end tabular-nums", canEdit && "cursor-text group/cell")} onDoubleClick={startEdit}><span className={cn("truncate block max-w-[200px]", typeColor, "group-hover/cell:opacity-80 transition-opacity")} title={displayStr}>{displayStr}</span></td>;
                                  })}
                                </tr>
                              );
                            })}
                            {info.rows.length === 0 && (
                              <tr>
                                <td
                                  colSpan={info.columns.length + 2}
                                  className="px-3 py-8 text-center text-muted-foreground/50 text-xs"
                                >
                                  {search ? "No matching rows" : "Empty table"}
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      )}
                    </div>
                    <ScrollBar orientation="horizontal" />
                  </ScrollArea>

                  {totalPages > 1 && (
                    <div className="flex items-center justify-between px-2.5 h-7 border-t border-border shrink-0">
                      <span className="text-[10px] text-muted-foreground tabular-nums">
                        {page} / {totalPages}
                      </span>
                      <div className="flex items-center gap-0.5">
                        <button
                          onClick={() =>
                            setOffset(Math.max(0, offset - PAGE_SIZE))
                          }
                          disabled={offset === 0}
                          className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-20 disabled:pointer-events-none"
                        >
                          <svg
                            className="w-3 h-3"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M15 19l-7-7 7-7"
                            />
                          </svg>
                        </button>
                        <button
                          onClick={() => setOffset(offset + PAGE_SIZE)}
                          disabled={offset + PAGE_SIZE >= (info?.total ?? 0)}
                          className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-20 disabled:pointer-events-none"
                        >
                          <svg
                            className="w-3 h-3"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M9 5l7 7-7 7"
                            />
                          </svg>
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* ── Query view ── */}
              {dbView === "query" && (
                <div className="flex flex-col flex-1 min-h-0">
                  {/* SQL Editor */}
                  <div className="relative shrink-0 border-b border-border">
                    {/* Syntax-highlighted overlay */}
                    <div
                      aria-hidden
                      className="absolute inset-0 px-3 py-2.5 font-mono text-[12px] leading-[1.6] pointer-events-none whitespace-pre-wrap break-words overflow-hidden"
                    >
                      {sql
                        .split(
                          /(\s+|'[^']*'|"[^"]*"|\d+(?:\.\d+)?|--[^\n]*|[(),;.*])/g,
                        )
                        .map((token, i) => {
                          if (!token) return null;
                          // String literals
                          if (/^['"][^]*['"]$/.test(token))
                            return (
                              <span key={i} className="text-emerald-400">
                                {token}
                              </span>
                            );
                          // Numbers
                          if (/^\d+(?:\.\d+)?$/.test(token))
                            return (
                              <span key={i} className="text-amber-400">
                                {token}
                              </span>
                            );
                          // Comments
                          if (/^--/.test(token))
                            return (
                              <span
                                key={i}
                                className="text-muted-foreground/50 italic"
                              >
                                {token}
                              </span>
                            );
                          // SQL keywords
                          if (SQL_KEYWORDS.has(token.toUpperCase()))
                            return (
                              <span
                                key={i}
                                className="text-primary font-medium"
                              >
                                {token}
                              </span>
                            );
                          // Punctuation
                          if (/^[(),;.*]$/.test(token))
                            return (
                              <span key={i} className="text-muted-foreground">
                                {token}
                              </span>
                            );
                          // Default
                          return (
                            <span key={i} className="text-foreground">
                              {token}
                            </span>
                          );
                        })}
                    </div>
                    <textarea
                      ref={sqlRef}
                      value={sql}
                      onChange={(e) => {
                        setSql(e.target.value);
                        setHistoryIdx(-1);
                      }}
                      onKeyDown={(e) => {
                        // Cmd/Ctrl+Enter to run
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          runQuery();
                          return;
                        }
                        // Up/Down arrow for history when at start/end
                        if (
                          e.key === "ArrowUp" &&
                          e.altKey &&
                          sqlHistory.length > 0
                        ) {
                          e.preventDefault();
                          const next = Math.min(
                            historyIdx + 1,
                            sqlHistory.length - 1,
                          );
                          setHistoryIdx(next);
                          setSql(sqlHistory[next]);
                        }
                        if (
                          e.key === "ArrowDown" &&
                          e.altKey &&
                          historyIdx >= 0
                        ) {
                          e.preventDefault();
                          const next = historyIdx - 1;
                          setHistoryIdx(next);
                          setSql(next < 0 ? "" : sqlHistory[next]);
                        }
                        // Tab inserts 2 spaces
                        if (e.key === "Tab") {
                          e.preventDefault();
                          const ta = e.currentTarget;
                          const start = ta.selectionStart;
                          const end = ta.selectionEnd;
                          const val = ta.value;
                          setSql(
                            val.substring(0, start) + "  " + val.substring(end),
                          );
                          requestAnimationFrame(() => {
                            ta.selectionStart = ta.selectionEnd = start + 2;
                          });
                        }
                      }}
                      placeholder="SELECT * FROM pages LIMIT 20;"
                      spellCheck={false}
                      className={cn(
                        "w-full resize-none px-3 py-2.5",
                        "font-mono text-[12px] leading-[1.6]",
                        "bg-muted/30 text-transparent caret-foreground",
                        "placeholder:text-muted-foreground/30",
                        "focus:outline-none",
                        "min-h-[72px] max-h-[160px]",
                      )}
                      rows={3}
                    />
                  </div>

                  {/* Query results */}
                  {queryResult && !queryResult.ok && (
                    <div className="px-3 py-2.5 border-b border-destructive/20 bg-destructive/5 shrink-0">
                      <div className="flex items-start gap-2">
                        <svg
                          className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                          />
                        </svg>
                        <span className="font-mono text-[11px] text-destructive break-all">
                          {queryResult.error}
                        </span>
                      </div>
                    </div>
                  )}

                  {(() => {
                    if (
                      !queryResult ||
                      !queryResult.ok ||
                      queryResult.columns.length === 0
                    )
                      return null;
                    const { columns: qCols, rows: qRows } = queryResult;
                    return (
                      <ScrollArea className="flex-1 min-h-0">
                        <div className="min-w-max">
                          <table className="w-full">
                            <thead className="sticky top-0 z-10">
                              <tr className="bg-muted/50 backdrop-blur-sm">
                                <th className="px-2.5 py-1 text-start text-[10px] font-medium text-muted-foreground uppercase tracking-wider w-8 border-b border-border">
                                  #
                                </th>
                                {qCols.map((col: string) => (
                                  <th
                                    key={col}
                                    className="px-2.5 py-1 text-start text-[10px] font-medium text-muted-foreground uppercase tracking-wider border-b border-border"
                                  >
                                    {col}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {qRows.map((row: DbRow, i: number) => (
                                <tr
                                  key={i}
                                  className="border-b border-border/30 hover:bg-muted/20 transition-colors"
                                >
                                  <td className="px-2.5 py-0.5 text-[10px] text-muted-foreground/50 font-mono tabular-nums">
                                    {i + 1}
                                  </td>
                                  {qCols.map((col: string) => {
                                    const v = row[col];
                                    const isNull =
                                      v === null || v === undefined;
                                    return (
                                      <td
                                        key={col}
                                        className="px-2.5 py-0.5 font-mono text-[11px]"
                                      >
                                        <span
                                          className={cn(
                                            "truncate block max-w-[300px]",
                                            isNull &&
                                              "text-muted-foreground/40 italic",
                                          )}
                                          title={fmtCell(v)}
                                        >
                                          {fmtCell(v)}
                                        </span>
                                      </td>
                                    );
                                  })}
                                </tr>
                              ))}
                              {qRows.length === 0 && (
                                <tr>
                                  <td
                                    colSpan={qCols.length + 1}
                                    className="px-3 py-8 text-center text-muted-foreground/50 text-xs"
                                  >
                                    Query returned no rows
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                        <ScrollBar orientation="horizontal" />
                      </ScrollArea>
                    );
                  })()}

                  {!queryResult && !queryRunning && (
                    <div className="flex-1 flex items-center justify-center">
                      <div className="text-center">
                        <p className="text-[11px] text-muted-foreground/40">
                          {navigator.platform.includes("Mac")
                            ? "\u2318"
                            : "Ctrl"}
                          +Enter to execute
                        </p>
                        <p className="text-[10px] text-muted-foreground/25 mt-1">
                          Alt+\u2191\u2193 to browse history
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </motion.div>
          )}

          {/* ── Logs tab ── */}
          {tab === "logs" && (
            <motion.div
              key="logs"
              {...tabMotion}
              className="flex flex-col flex-1 min-h-0"
            >
              <div className="flex items-center h-8 px-2 border-b border-border shrink-0 gap-1.5">
                <div className="flex items-center gap-0.5">
                  {(["all", ...LOG_LEVELS] as const).map((l) => (
                    <button
                      key={l}
                      onClick={() => setLevelFilter(l)}
                      className={cn(
                        "px-1.5 py-0.5 rounded text-[10px] uppercase transition-colors",
                        levelFilter === l
                          ? "bg-muted text-foreground font-medium"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {l}
                    </button>
                  ))}
                </div>
                <div className="w-px h-3.5 bg-border shrink-0" />
                <div className="relative flex items-center flex-1 max-w-[200px]">
                  <svg
                    className="absolute start-2 w-3 h-3 text-muted-foreground pointer-events-none"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                    />
                  </svg>
                  <input
                    type="text"
                    value={logFilter}
                    onChange={(e) => setLogFilter(e.target.value)}
                    placeholder="Filter..."
                    className="h-5 w-full ps-7 pe-5 text-[11px] rounded bg-transparent text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
                  />
                  {logFilter && (
                    <button
                      onClick={() => setLogFilter("")}
                      className="absolute end-1 text-muted-foreground hover:text-foreground"
                    >
                      <svg
                        className="w-3 h-3"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </button>
                  )}
                </div>
                <div className="flex-1" />
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {filteredLogs.length}
                </span>
                <button
                  onClick={copyLogs}
                  className="h-5 px-1.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  {logsCopied ? "Copied!" : "Copy"}
                </button>
                <button
                  onClick={exportLogs}
                  className="h-5 px-1.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  Export
                </button>
                <button
                  onClick={clearConsoleLogs}
                  className="h-5 px-1.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  Clear
                </button>
              </div>

              <ScrollArea className="flex-1 min-h-0">
                <div className="font-mono text-[11px]">
                  {filteredLogs.map((entry) => (
                    <div
                      key={entry.id}
                      className={cn(
                        "flex gap-2 px-2.5 py-0.5 border-b border-border/20 hover:bg-muted/20 transition-colors",
                        entry.level === "error" && "bg-red-500/5",
                        entry.level === "warn" && "bg-amber-500/5",
                      )}
                    >
                      <span className="text-[10px] text-muted-foreground/50 tabular-nums shrink-0 pt-px">
                        {fmtTime(entry.timestamp)}
                      </span>
                      <span
                        className={cn(
                          "text-[10px] uppercase w-10 shrink-0 pt-px font-medium",
                          LEVEL_COLORS[entry.level],
                        )}
                      >
                        {entry.level === "log"
                          ? "LOG"
                          : entry.level.toUpperCase()}
                      </span>
                      <span className="text-foreground break-all min-w-0">
                        {entry.message}
                      </span>
                    </div>
                  ))}
                  {filteredLogs.length === 0 && (
                    <div className="px-3 py-8 text-center text-muted-foreground/50 text-xs">
                      {logFilter || levelFilter !== "all"
                        ? "No matching logs"
                        : "No logs yet"}
                    </div>
                  )}
                  <div ref={logEndRef} />
                </div>
              </ScrollArea>
            </motion.div>
          )}

          {/* ── Network tab ── */}
          {tab === "network" && (
            <motion.div
              key="net"
              {...tabMotion}
              className="flex flex-col flex-1 min-h-0"
            >
              <div className="flex items-center h-8 px-2 border-b border-border shrink-0 gap-1.5">
                {/* Direction filter */}
                {(["all", "send", "recv"] as const).map((d) => (
                  <button
                    key={d}
                    onClick={() => setDirFilter(d)}
                    className={cn(
                      "px-1.5 py-0.5 rounded text-[10px] uppercase transition-colors",
                      dirFilter === d
                        ? "bg-muted text-foreground font-medium"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {d === "send" ? "out" : d === "recv" ? "in" : d}
                  </button>
                ))}

                <div className="w-px h-3.5 bg-border shrink-0" />

                {/* Type filter */}
                <select
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                  className="h-5 px-1.5 text-[10px] rounded bg-transparent border border-border text-foreground focus:outline-none"
                >
                  <option value="all">all types</option>
                  {msgTypes.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>

                <div className="w-px h-3.5 bg-border shrink-0" />

                {/* Text filter */}
                <div className="relative flex items-center flex-1 max-w-[180px]">
                  <svg
                    className="absolute start-2 w-3 h-3 text-muted-foreground pointer-events-none"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                    />
                  </svg>
                  <input
                    type="text"
                    value={netFilter}
                    onChange={(e) => setNetFilter(e.target.value)}
                    placeholder="Filter..."
                    className="h-5 w-full ps-7 pe-5 text-[11px] rounded bg-transparent text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
                  />
                  {netFilter && (
                    <button
                      onClick={() => setNetFilter("")}
                      className="absolute end-1 text-muted-foreground hover:text-foreground"
                    >
                      <svg
                        className="w-3 h-3"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </button>
                  )}
                </div>

                <div className="flex-1" />

                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {filteredNet.length}
                </span>
                <button
                  onClick={copyNetLogs}
                  className="h-5 px-1.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  {netCopied ? "Copied!" : "Copy"}
                </button>
                <button
                  onClick={exportNetLogs}
                  className="h-5 px-1.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  Export
                </button>
                <button
                  onClick={clearNetLogs}
                  className="h-5 px-1.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  Clear
                </button>
              </div>

              <ScrollArea className="flex-1 min-h-0">
                <div className="font-mono text-[11px]">
                  {filteredNet.map((entry) => {
                    const dir = DIR_STYLE[entry.direction];
                    return (
                      <div
                        key={entry.id}
                        className="flex items-baseline gap-2 px-2.5 py-0.5 border-b border-border/20 hover:bg-muted/20 transition-colors"
                      >
                        <span className="text-[10px] text-muted-foreground/50 tabular-nums shrink-0">
                          {fmtTime(entry.timestamp)}
                        </span>
                        <span
                          className={cn(
                            "text-[10px] w-7 shrink-0 font-semibold",
                            dir.color,
                          )}
                        >
                          {dir.label}
                        </span>
                        <span
                          className="text-[10px] text-muted-foreground shrink-0 w-16 truncate"
                          title={entry.peer}
                        >
                          {entry.peer}
                        </span>
                        <span className="text-foreground font-medium shrink-0">
                          {entry.type}
                        </span>
                        <span className="text-muted-foreground truncate min-w-0">
                          {entry.summary}
                        </span>
                        <span className="text-[10px] text-muted-foreground/40 tabular-nums shrink-0 ms-auto">
                          {entry.size}B
                        </span>
                      </div>
                    );
                  })}
                  {filteredNet.length === 0 && (
                    <div className="px-3 py-8 text-center text-muted-foreground/50 text-xs">
                      {netFilter || dirFilter !== "all" || typeFilter !== "all"
                        ? "No matching messages"
                        : "No network activity yet"}
                    </div>
                  )}
                  <div ref={netEndRef} />
                </div>
              </ScrollArea>
            </motion.div>
          )}

          {/* ── CRDT tab ── */}
          {tab === "crdt" && (
            <motion.div
              key="crdt"
              {...tabMotion}
              className="relative flex flex-col flex-1 min-h-0"
            >
              <div className="flex items-center h-8 px-2 border-b border-border shrink-0 gap-1.5">
                {/* Page filter */}
                <select
                  value={crdtPageId}
                  onChange={(e) => setCrdtPageId(e.target.value)}
                  className="h-5 px-1.5 text-[10px] rounded bg-transparent border border-border text-foreground focus:outline-none max-w-[140px]"
                >
                  <option value="all">all pages</option>
                  {crdtPages.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title.startsWith("space:") ? `[space] ${p.title.slice(6, 14)}...` : p.title || p.id.slice(0, 12)}
                    </option>
                  ))}
                </select>

                <div className="w-px h-3.5 bg-border shrink-0" />

                {/* Op type filter */}
                <select
                  value={crdtOpType}
                  onChange={(e) => setCrdtOpType(e.target.value)}
                  className="h-5 px-1.5 text-[10px] rounded bg-transparent border border-border text-foreground focus:outline-none"
                >
                  <option value="all">all ops</option>
                  {CRDT_OP_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>

                <div className="w-px h-3.5 bg-border shrink-0" />

                {/* Text filter */}
                <div className="relative flex items-center flex-1 max-w-[180px]">
                  <svg
                    className="absolute start-2 w-3 h-3 text-muted-foreground pointer-events-none"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                    />
                  </svg>
                  <input
                    type="text"
                    value={crdtFilter}
                    onChange={(e) => setCrdtFilter(e.target.value)}
                    placeholder="Filter..."
                    className="h-5 w-full ps-7 pe-5 text-[11px] rounded bg-transparent text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
                  />
                  {crdtFilter && (
                    <button
                      onClick={() => setCrdtFilter("")}
                      className="absolute end-1 text-muted-foreground hover:text-foreground"
                    >
                      <svg
                        className="w-3 h-3"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </button>
                  )}
                </div>

                <div className="flex-1" />

                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {getFilteredCrdtOps().length}
                </span>
                <button
                  onClick={copyCrdtOps}
                  className="h-5 px-1.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  {crdtCopied ? "Copied!" : "Copy"}
                </button>
                <button
                  onClick={openCrdtExport}
                  className="h-5 px-1.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  Export
                </button>
                <button
                  onClick={loadCrdtOps}
                  className={cn(
                    "h-5 px-1.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors",
                    crdtLoading && "animate-pulse",
                  )}
                >
                  Reload
                </button>
              </div>

              <ScrollArea className="flex-1 min-h-0">
                <div className="font-mono text-[11px]">
                  {getFilteredCrdtOps().map((op) => {
                      const isExpanded = crdtExpanded === op.id;
                      return (
                        <div key={op.id}>
                          <button
                            onClick={() =>
                              setCrdtExpanded(isExpanded ? null : op.id)
                            }
                            className="flex items-baseline gap-2 px-2.5 py-0.5 border-b border-border/20 hover:bg-muted/20 transition-colors w-full text-start"
                          >
                            <span className="text-[10px] text-muted-foreground/50 tabular-nums shrink-0">
                              {op.clock}
                            </span>
                            <span
                              className={cn(
                                "text-[10px] shrink-0 font-semibold w-24 text-start",
                                OP_TYPE_COLORS[op.type] ?? "text-foreground",
                              )}
                            >
                              {op.type}
                            </span>
                            <span
                              className="text-[10px] text-muted-foreground shrink-0 w-16 truncate"
                              title={op.peerId}
                            >
                              {op.peerId.slice(0, 8)}
                            </span>
                            <span className="text-muted-foreground truncate min-w-0">
                              {crdtOpSummary(op)}
                            </span>
                            <svg
                              className={cn(
                                "w-3 h-3 text-muted-foreground/30 shrink-0 ms-auto transition-transform",
                                isExpanded && "rotate-180",
                              )}
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              strokeWidth={2}
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M19 9l-7 7-7-7"
                              />
                            </svg>
                          </button>
                          {isExpanded && (
                            <div className="px-4 py-2 bg-muted/30 border-b border-border/20">
                              <pre className="text-[10px] text-muted-foreground whitespace-pre-wrap break-all">
                                {JSON.stringify(op.data, null, 2)}
                              </pre>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  {crdtOps.length === 0 && (
                    <div className="px-3 py-8 text-center text-muted-foreground/50 text-xs">
                      {crdtLoading ? "Loading..." : "No operations found"}
                    </div>
                  )}
                </div>
              </ScrollArea>

              {/* Export dialog */}
              {crdtExportOpen && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60 backdrop-blur-sm">
                  <div className="w-[280px] rounded-lg border border-border bg-popover shadow-2xl p-4 flex flex-col gap-3">
                    <div className="text-xs font-semibold text-foreground">
                      Export CRDT ops
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {crdtExportTotal === null ? (
                        "Counting rows…"
                      ) : (
                        <>
                          {crdtExportTotal.toLocaleString()} op
                          {crdtExportTotal === 1 ? "" : "s"} match the current
                          filters. How many do you want to export?
                        </>
                      )}
                    </div>
                    <input
                      type="number"
                      min={1}
                      max={crdtExportTotal ?? undefined}
                      value={crdtExportLimit}
                      onChange={(e) => setCrdtExportLimit(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") runCrdtExport();
                        if (e.key === "Escape") setCrdtExportOpen(false);
                      }}
                      autoFocus
                      disabled={crdtExportTotal === null}
                      className="h-7 px-2 text-xs rounded bg-transparent border border-border text-foreground focus:outline-none focus:border-foreground/40 tabular-nums"
                    />
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => setCrdtExportOpen(false)}
                        className="h-6 px-2 rounded text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={runCrdtExport}
                        disabled={
                          crdtExporting ||
                          crdtExportTotal === null ||
                          !(Number(crdtExportLimit) > 0)
                        }
                        className="h-6 px-2 rounded text-[11px] text-foreground bg-muted hover:bg-muted/70 transition-colors disabled:opacity-40"
                      >
                        {crdtExporting ? "Exporting…" : "Export"}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {/* ── Peers tab ── */}
          {tab === "peers" && (
            <motion.div
              key="peers"
              {...tabMotion}
              className="flex flex-col flex-1 min-h-0"
            >
              <ScrollArea className="flex-1 min-h-0">
                <div className="p-3 flex flex-col gap-2">
                  {(() => {
                    // Build per-peer stats from netLogs
                    type PeerStats = {
                      sent: number;
                      recv: number;
                      bytesSent: number;
                      bytesRecv: number;
                      lastActivity: number;
                      types: Record<string, { send: number; recv: number }>;
                    };
                    const statsMap = new Map<string, PeerStats>();
                    for (const entry of netLogs) {
                      let s = statsMap.get(entry.peer);
                      if (!s) {
                        s = { sent: 0, recv: 0, bytesSent: 0, bytesRecv: 0, lastActivity: 0, types: {} };
                        statsMap.set(entry.peer, s);
                      }
                      if (entry.direction === "send") { s.sent++; s.bytesSent += entry.size; }
                      else { s.recv++; s.bytesRecv += entry.size; }
                      if (entry.timestamp > s.lastActivity) s.lastActivity = entry.timestamp;
                      if (!s.types[entry.type]) s.types[entry.type] = { send: 0, recv: 0 };
                      if (entry.direction === "send") s.types[entry.type].send++;
                      else s.types[entry.type].recv++;
                    }

                    // Build per-peer lookup from DB
                    const knownByShortKey = new Map<string, Peer>();
                    for (const p of knownPeers) knownByShortKey.set(p.publicKey.slice(0, 8), p);

                    // Build display list: connected + netlog + all known DB peers
                    const connectedSet = new Set(connectedPeers.map((k) => k.slice(0, 8)));
                    const allPeerIds = [...new Set([
                      ...connectedPeers.map((k) => k.slice(0, 8)),
                      ...statsMap.keys(),
                      ...knownPeers.map((p) => p.publicKey.slice(0, 8)),
                    ])];

                    // Compute last communicated for each peer (netlog activity > DB lastSeen)
                    const lastComm = (shortKey: string): number => {
                      const activity = statsMap.get(shortKey)?.lastActivity ?? 0;
                      const dbSeen = knownByShortKey.get(shortKey)?.lastSeen
                        ? new Date(knownByShortKey.get(shortKey)!.lastSeen!).getTime()
                        : 0;
                      return Math.max(activity, dbSeen);
                    };

                    // Sort: connected first, then by last communicated desc
                    allPeerIds.sort((a, b) => {
                      const aC = connectedSet.has(a) ? 1 : 0;
                      const bC = connectedSet.has(b) ? 1 : 0;
                      if (aC !== bC) return bC - aC;
                      return lastComm(b) - lastComm(a);
                    });

                    // Aggregate totals across all peers
                    let totalSent = 0, totalRecv = 0, totalBytesSent = 0, totalBytesRecv = 0;
                    const totalTypes: Record<string, { send: number; recv: number }> = {};
                    for (const s of statsMap.values()) {
                      totalSent += s.sent;
                      totalRecv += s.recv;
                      totalBytesSent += s.bytesSent;
                      totalBytesRecv += s.bytesRecv;
                      for (const [type, counts] of Object.entries(s.types)) {
                        if (!totalTypes[type]) totalTypes[type] = { send: 0, recv: 0 };
                        totalTypes[type].send += counts.send;
                        totalTypes[type].recv += counts.recv;
                      }
                    }
                    const topTotalTypes = Object.entries(totalTypes)
                      .sort((a, b) => (b[1].send + b[1].recv) - (a[1].send + a[1].recv))
                      .slice(0, 6);

                    if (allPeerIds.length === 0) {
                      return (
                        <div className="py-8 text-center text-muted-foreground/50 text-xs">
                          No peers seen yet
                        </div>
                      );
                    }

                    return (
                      <>
                        {/* Summary card */}
                        <div className="rounded-lg border border-border bg-muted/30 p-2.5 flex flex-col gap-1.5">
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] font-semibold text-foreground">All peers</span>
                            <span className="text-[10px] text-muted-foreground tabular-nums">
                              {connectedPeers.length} connected · {allPeerIds.length} total
                            </span>
                          </div>
                          <div className="flex items-center gap-3 text-[10px] font-mono">
                            <span className="text-sky-400">↑ {totalSent} <span className="text-muted-foreground/50">({fmtBytes(totalBytesSent)})</span></span>
                            <span className="text-amber-400">↓ {totalRecv} <span className="text-muted-foreground/50">({fmtBytes(totalBytesRecv)})</span></span>
                          </div>
                          {topTotalTypes.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {topTotalTypes.map(([type, counts]) => (
                                <span key={type} className="inline-flex items-center gap-0.5 px-1 py-px rounded text-[9px] bg-muted text-muted-foreground font-mono">
                                  {type}
                                  {counts.send > 0 && <span className="text-sky-400/70">↑{counts.send}</span>}
                                  {counts.recv > 0 && <span className="text-amber-400/70">↓{counts.recv}</span>}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Per-peer cards */}
                        {allPeerIds.map((shortKey) => {
                      const idx = connectedPeers.findIndex((k) => k.slice(0, 8) === shortKey);
                      const dbPeer = knownByShortKey.get(shortKey);
                      const name = idx >= 0
                        ? connectedPeerNames[idx]
                        : (dbPeer?.name || shortKey);
                      const isConnected = connectedSet.has(shortKey);
                      const stats = statsMap.get(shortKey);
                      const topTypes = stats
                        ? Object.entries(stats.types)
                            .sort((a, b) => (b[1].send + b[1].recv) - (a[1].send + a[1].recv))
                            .slice(0, 4)
                        : [];
                      const lc = lastComm(shortKey);

                      return (
                        <div
                          key={shortKey}
                          className={cn(
                            "rounded-lg border p-2.5 flex flex-col gap-1.5",
                            isConnected ? "border-emerald-500/30 bg-emerald-500/5" : "border-border/50 bg-muted/20",
                          )}
                        >
                          {/* Header */}
                          <div className="flex items-center gap-2">
                            <div className={cn("w-1.5 h-1.5 rounded-full shrink-0", isConnected ? "bg-emerald-500" : "bg-muted-foreground/30")} />
                            <span className="text-[11px] font-medium text-foreground truncate flex-1">{name}</span>
                            <span className="text-[10px] text-muted-foreground/50 font-mono shrink-0">{shortKey}</span>
                          </div>

                          {/* Last communicated */}
                          <div className="text-[10px] text-muted-foreground/50">
                            {isConnected
                              ? <span className="text-emerald-400/80">Connected</span>
                              : lc > 0
                                ? <span>Last seen {fmtRelTime(lc)}</span>
                                : <span>Never connected</span>
                            }
                          </div>

                          {/* Stats row */}
                          {stats ? (
                            <>
                              <div className="flex items-center gap-3 text-[10px] font-mono">
                                <span className="text-sky-400">↑ {stats.sent} <span className="text-muted-foreground/50">({fmtBytes(stats.bytesSent)})</span></span>
                                <span className="text-amber-400">↓ {stats.recv} <span className="text-muted-foreground/50">({fmtBytes(stats.bytesRecv)})</span></span>
                              </div>
                              {topTypes.length > 0 && (
                                <div className="flex flex-wrap gap-1">
                                  {topTypes.map(([type, counts]) => (
                                    <span
                                      key={type}
                                      className="inline-flex items-center gap-0.5 px-1 py-px rounded text-[9px] bg-muted text-muted-foreground font-mono"
                                    >
                                      {type}
                                      {counts.send > 0 && <span className="text-sky-400/70">↑{counts.send}</span>}
                                      {counts.recv > 0 && <span className="text-amber-400/70">↓{counts.recv}</span>}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </>
                          ) : (
                            <span className="text-[10px] text-muted-foreground/40">No messages this session</span>
                          )}
                        </div>
                      );
                    })}
                      </>
                    );
                  })()}
                </div>
              </ScrollArea>
            </motion.div>
          )}
        </motion.div>
      ) : (
        <motion.div
          key="pill"
          initial={{ y: 12, opacity: 0, scale: 0.95 }}
          animate={{ y: 0, opacity: 1, scale: 1 }}
          exit={{ y: 12, opacity: 0, scale: 0.95 }}
          transition={{ type: "spring", damping: 30, stiffness: 500 }}
          className={cn(
            "fixed bottom-3 end-3 z-40",
            "bg-popover/95 backdrop-blur-xl",
            "border border-border rounded-full",
            "shadow-lg font-sans",
            "flex items-center h-8 px-0.5 gap-0.5",
          )}
        >
          <button
            onClick={() => setOpen(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <div
              className={cn(
                "w-1.5 h-1.5 rounded-full shrink-0",
                conn === "connected" ? "bg-emerald-500" : "bg-red-500",
              )}
            />
            <span className="text-[11px] font-medium">Dev</span>
          </button>
          <div
            className={cn(
              "flex items-center h-6 px-2 gap-1 rounded-full",
              "border border-border/70 bg-muted/40",
              "text-[10px] text-muted-foreground tabular-nums",
            )}
            title={peersSummary}
          >
            <svg
              className="w-2.5 h-2.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M17 20a4 4 0 00-8 0m8 0H7m10 0h3m-3 0a4 4 0 00-8 0m-5 0h3m0 0a4 4 0 018 0m0-8a3 3 0 11-6 0 3 3 0 016 0zm6 1a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zM8 13a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z"
              />
            </svg>
            {connectedPeers.length}
          </div>
          <button
            onClick={() => setHidden(true)}
            className="flex items-center justify-center w-6 h-6 rounded-full text-muted-foreground/50 hover:text-foreground hover:bg-muted transition-colors"
          >
            <svg
              className="w-2.5 h-2.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
