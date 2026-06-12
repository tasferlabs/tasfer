"use client";

import {
  createContext,
  useContext,
  useId,
  useMemo,
  useState,
  type ReactNode,
  type AnchorHTMLAttributes,
} from "react";
import { Link } from "@/components/Link";
import { Icons } from "./docsIcons";

/* ============================================================
   Shared documentation components — ported from docs-ui.jsx.
   A tiny syntax tinter, code blocks, install tabs, callouts,
   tables, cards, steps, and a license card.
   ============================================================ */

/* ── tiny syntax highlighter (returns React nodes) ── */
const JS_KW = new Set(
  (
    "const let var function return import from export default new class extends " +
    "if else for while do await async of in typeof instanceof null true false this void try catch " +
    "throw switch case break continue yield static get set as interface type enum implements public " +
    "private readonly super"
  ).split(" "),
);

function tintJS(code: string, keyPrefix: string): ReactNode[] {
  const re =
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)|(\s+)|([^\w\s])/g;
  const out: ReactNode[] = [];
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(code))) {
    const k = keyPrefix + "-" + i++;
    if (m[1]) out.push(<span key={k} className="tok-com">{m[1]}</span>);
    else if (m[2]) out.push(<span key={k} className="tok-str">{m[2]}</span>);
    else if (m[3]) out.push(<span key={k} className="tok-num">{m[3]}</span>);
    else if (m[4]) {
      if (JS_KW.has(m[4])) out.push(<span key={k} className="tok-kw">{m[4]}</span>);
      else {
        const after = code[re.lastIndex];
        if (after === "(") out.push(<span key={k} className="tok-fn">{m[4]}</span>);
        else out.push(m[4]);
      }
    } else if (m[5]) out.push(m[5]);
    else out.push(<span key={k} className="tok-punc">{m[6]}</span>);
  }
  return out;
}

function tintBash(code: string, keyPrefix: string): ReactNode[] {
  return code.split("\n").map((line, li) => {
    const nodes: ReactNode[] = [];
    const re = /(#[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\s+)|(\S+)/g;
    let m: RegExpExecArray | null;
    let i = 0;
    let firstWord = true;
    while ((m = re.exec(line))) {
      const k = keyPrefix + "-" + li + "-" + i++;
      if (m[1]) nodes.push(<span key={k} className="tok-com">{m[1]}</span>);
      else if (m[2]) nodes.push(<span key={k} className="tok-str">{m[2]}</span>);
      else if (m[3]) nodes.push(m[3]);
      else {
        const w = m[4];
        if (firstWord && /^[a-z]/i.test(w)) {
          nodes.push(<span key={k} className="tok-fn">{w}</span>);
          firstWord = false;
        } else if (w.startsWith("-")) {
          nodes.push(<span key={k} className="tok-kw">{w}</span>);
        } else {
          nodes.push(w);
          if (w !== "&&" && w !== "|") firstWord = false;
          if (w === "&&" || w === "|") firstWord = true;
        }
      }
    }
    return (
      <span key={keyPrefix + "-l" + li}>
        {li > 0 ? "\n" : null}
        {nodes}
      </span>
    );
  });
}

function tint(code: string, lang: string, keyPrefix: string): ReactNode[] {
  if (lang === "bash" || lang === "sh" || lang === "shell")
    return tintBash(code, keyPrefix);
  if (lang === "text" || lang === "html") return [code];
  return tintJS(code, keyPrefix);
}

/* ── internal/external link helper ──
   Absolute in-app paths ("/docs/...", "/home") route through react-router;
   anything else is treated as external and opens in a new tab. */
export function A({
  href = "",
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  if (href.startsWith("/")) {
    return (
      <Link to={href} {...rest}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" {...rest}>
      {children}
    </a>
  );
}

/* ── copy button ── */
export function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  function copy() {
    const write =
      navigator.clipboard && navigator.clipboard.writeText
        ? navigator.clipboard.writeText(text)
        : Promise.reject(new Error("no clipboard"));
    write.catch(() => {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* ignore */
      }
      document.body.removeChild(ta);
    });
    setDone(true);
    setTimeout(() => setDone(false), 1600);
  }
  return (
    <button
      className={"dx-copy" + (done ? " is-copied" : "")}
      onClick={copy}
      aria-label="copy code"
    >
      {done ? <Icons.Check /> : <Icons.Copy />}
      {done ? "copied" : "copy"}
    </button>
  );
}

/* ── generic code block ── */
export function Code({
  code,
  lang = "tsx",
  file,
  terminal = false,
}: {
  code: string;
  lang?: string;
  file?: string;
  terminal?: boolean;
}) {
  const id = useId();
  const trimmed = code.replace(/^\n/, "").replace(/\s+$/, "");
  return (
    <div className={"dx-code" + (terminal ? " is-terminal" : "")}>
      <div className="dx-code-head">
        {file ? (
          <span className="dx-code-file">{file}</span>
        ) : (
          <span className="dx-code-lang">{lang}</span>
        )}
        <span className="dx-code-spacer" />
        <CopyBtn text={trimmed} />
      </div>
      <pre>
        <code>{tint(trimmed, lang, id)}</code>
      </pre>
    </div>
  );
}

/* ── install tabs (npm / pnpm / yarn / bun) ──
   Every install block that shares a `group` stays in sync: picking a manager in
   one block switches all other blocks in the same group, live. The selection is
   also persisted to localStorage so it survives reloads and navigation. The
   shared state lives in React context (no module-level globals) and is supplied
   by <PkgMgrProvider> wrapped around the docs article. */
type Mgr = "npm" | "pnpm" | "yarn" | "bun";
const MGRS: Mgr[] = ["npm", "pnpm", "yarn", "bun"];

/* Keep the original key for the default group so existing prefs carry over. */
function pkgMgrLsKey(group: string) {
  return group === "pkg" ? "cy-pkg-mgr" : `cy-pkg-mgr:${group}`;
}
function readPkgMgr(group: string): Mgr {
  try {
    const v = localStorage.getItem(pkgMgrLsKey(group)) as Mgr | null;
    return v && MGRS.includes(v) ? v : "npm";
  } catch {
    return "npm";
  }
}
function writePkgMgr(group: string, mgr: Mgr) {
  try {
    localStorage.setItem(pkgMgrLsKey(group), mgr);
  } catch {
    /* ignore */
  }
}

interface PkgMgrStore {
  get(group: string): Mgr;
  set(group: string, mgr: Mgr): void;
}
const PkgMgrContext = createContext<PkgMgrStore | null>(null);

/** Shares the selected package manager (per `group`) across every InstallTabs
 *  rendered beneath it, so blocks with the same key switch together. */
export function PkgMgrProvider({ children }: { children: ReactNode }) {
  const [byGroup, setByGroup] = useState<Record<string, Mgr>>({});
  const store = useMemo<PkgMgrStore>(
    () => ({
      get: (group) => byGroup[group] ?? readPkgMgr(group),
      set: (group, mgr) => {
        setByGroup((prev) => ({ ...prev, [group]: mgr }));
        writePkgMgr(group, mgr);
      },
    }),
    [byGroup],
  );
  return <PkgMgrContext.Provider value={store}>{children}</PkgMgrContext.Provider>;
}

export function InstallTabs({
  pkg,
  dev = false,
  group = "pkg",
}: {
  pkg: string;
  dev?: boolean;
  group?: string;
}) {
  const id = useId();
  const ctx = useContext(PkgMgrContext);
  // Fallback for any InstallTabs rendered outside a PkgMgrProvider: behaves like
  // the old per-block state, still persisted to localStorage.
  const [localMgr, setLocalMgr] = useState<Mgr>(() => readPkgMgr(group));
  const mgr = ctx ? ctx.get(group) : localMgr;
  function pick(m: Mgr) {
    if (ctx) ctx.set(group, m);
    else {
      setLocalMgr(m);
      writePkgMgr(group, m);
    }
  }
  const D = dev ? " -D" : "";
  const cmds: Record<Mgr, string> = {
    npm: `npm install${dev ? " --save-dev" : ""} ${pkg}`,
    pnpm: `pnpm add${D} ${pkg}`,
    yarn: `yarn add${D} ${pkg}`,
    bun: `bun add${D} ${pkg}`,
  };
  return (
    <div className="dx-code is-terminal">
      <div className="dx-code-head">
        <div className="dx-code-tabs">
          {MGRS.map((m) => (
            <button
              key={m}
              className={"dx-code-tab" + (m === mgr ? " is-active" : "")}
              onClick={() => pick(m)}
            >
              {m}
            </button>
          ))}
        </div>
        <span className="dx-code-spacer" />
        <CopyBtn text={cmds[mgr]} />
      </div>
      <pre>
        <code>
          <span className="tok-prompt">$ </span>
          {tint(cmds[mgr], "bash", id + mgr)}
        </code>
      </pre>
    </div>
  );
}

/* ── callout ── */
export function Callout({
  kind = "note",
  title,
  children,
}: {
  kind?: "note" | "warn" | "tip";
  title?: ReactNode;
  children?: ReactNode;
}) {
  const ic =
    kind === "warn" ? <Icons.Warn /> : kind === "tip" ? <Icons.Spark /> : <Icons.Info />;
  return (
    <div className={"dx-callout " + kind}>
      <span className="dx-callout-icon">{ic}</span>
      <div>
        {title ? (
          <p>
            <strong>{title}</strong>
          </p>
        ) : null}
        <div className="dx-callout-body">{children}</div>
      </div>
    </div>
  );
}

/* ── props / params table ── */
export interface PropRow {
  name: string;
  type: ReactNode;
  desc: ReactNode;
  required?: boolean;
}
export function PropsTable({
  rows,
  cols = ["Prop", "Type", "Description"],
}: {
  rows: PropRow[];
  cols?: string[];
}) {
  return (
    <div className="dx-table-wrap">
      <table className="dx-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="name">
                <code>{r.name}</code>
                {r.required ? <span className="req">required</span> : null}
              </td>
              <td>
                <span className="ty">{r.type}</span>
              </td>
              <td className="desc">{r.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── card grid ── */
export function CardGrid({ children }: { children: ReactNode }) {
  return <div className="dx-card-grid">{children}</div>;
}
export function Card({
  to,
  icon,
  title,
  desc,
}: {
  to: string;
  icon?: ReactNode;
  title: ReactNode;
  desc: ReactNode;
}) {
  return (
    <Link className="dx-card" to={"/docs/" + to}>
      {icon ? <span className="dx-card-ic">{icon}</span> : null}
      <span className="dx-card-title">
        {title} <Icons.ChevronRight className="arr" />
      </span>
      <p className="dx-card-desc">{desc}</p>
    </Link>
  );
}

/* ── steps ── */
export function Steps({ children }: { children: ReactNode }) {
  return <ol className="dx-steps">{children}</ol>;
}
export function Step({ title, children }: { title?: ReactNode; children?: ReactNode }) {
  return (
    <li className="dx-step">
      {title ? <div className="dx-step-title">{title}</div> : null}
      {children}
    </li>
  );
}

/* ── license card ── */
export function LicenseCard({ children }: { children: ReactNode }) {
  return (
    <div className="dx-license">
      <span className="dx-license-badge">MIT</span>
      <p>{children}</p>
    </div>
  );
}
