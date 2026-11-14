"use client";

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { REPO_URL } from "@/lib/seo";
import { Code, CopyBtn, InstallTabs } from "../docsComponents";
import { Icons } from "../docsIcons";
import editorData from "./data/editor.json";
import indexData from "./data/index.json";
import type {
  ApiDocFields,
  ApiIndex,
  ApiKind,
  ApiMember,
  ApiPackage,
  ApiSymbol,
  MdNode,
} from "./types";

/* ============================================================
   The API reference: every export of every @tasfer/* package on
   one page, one package at a time.

   The data is generated from the packages' source by
   scripts/generate-api.mjs and committed under ./data. Nothing on
   this page is written by hand — to change what a row says, change
   the doc comment in the code and run `npm run api`.

   The page is addressable like the rest of the docs:

     ?pkg=math            which package is showing
     #createEditor        an export, opened and scrolled to
     #Node.layout         one member of an export
     #group-class         a group of exports, opened and scrolled to

   A package's exports are listed in groups, one per kind. One group
   is open at a time and starts with its first few rows; the others
   fold down to a row each, so the page stays short.
   ============================================================ */

const INDEX = indexData as ApiIndex;
const DEFAULT_SLUG = INDEX.packages[0].slug;
/** The default package ships with the page, so the prerendered HTML has it. */
const PRELOADED = editorData as unknown as ApiPackage;

const KIND_ORDER: ApiKind[] = [
  "function",
  "class",
  "interface",
  "type",
  "const",
  "enum",
  "namespace",
];

/** The keyword a kind is declared with — code, so not translated. */
const KIND_TAG: Record<ApiKind, string> = {
  function: "fn",
  class: "class",
  interface: "interface",
  type: "type",
  const: "const",
  enum: "enum",
  namespace: "namespace",
};

/** Rows a group starts with; the rest wait behind "Show all". */
const PAGE = 10;

/** The picker's sections. A package nobody has placed is an extension. */
type PkgGroup = "core" | "extensions" | "providers";
const PKG_GROUPS: PkgGroup[] = ["core", "extensions", "providers"];
const CORE_PACKAGES = new Set(["editor", "react"]);
function pkgGroupOf(slug: string): PkgGroup {
  if (CORE_PACKAGES.has(slug)) return "core";
  return slug.startsWith("provider-") ? "providers" : "extensions";
}

/** Anchors with this prefix are sections of the page, not exports. */
const GROUP_PREFIX = "group-";
const PACKAGES_ANCHOR = GROUP_PREFIX + "packages";
const entryGroupId = (entry: string) =>
  GROUP_PREFIX + entry.replace(/[^a-z0-9]+/gi, "-");

const SIG_KEYWORDS = new Set(
  (
    "function class interface type const enum namespace extends implements readonly " +
    "abstract static new keyof typeof infer protected public get set in is asserts " +
    "unique declare override async"
  ).split(" "),
);

/* ── versions ── */

function isNewer(version: string, than: string): boolean {
  const a = version.split(".").map(Number);
  const b = than.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/* ── addressing ── */

const anchorOf = (symbol: ApiSymbol) => symbol.anchor ?? symbol.name;

function hrefOf(slug: string, anchor: string) {
  return `?pkg=${slug}#${encodeURIComponent(anchor)}`;
}

function readLocation(): { slug: string; target: string | null } {
  let slug = DEFAULT_SLUG;
  let target: string | null = null;
  try {
    const asked = new URLSearchParams(window.location.search).get("pkg");
    if (asked && INDEX.packages.some((p) => p.slug === asked)) slug = asked;
    const hash = decodeURIComponent(window.location.hash.slice(1));
    if (hash) target = hash;
  } catch {
    /* a malformed URL shows the default package */
  }
  return { slug, target };
}

function writeLocation(slug: string, anchor: string | null, push = false) {
  try {
    const url = new URL(window.location.href);
    if (slug === DEFAULT_SLUG) url.searchParams.delete("pkg");
    else url.searchParams.set("pkg", slug);
    url.hash = anchor ? encodeURIComponent(anchor) : "";
    if (push) window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
  } catch {
    /* ignore */
  }
}

/** Everything a nested renderer needs to turn a name into a link. */
interface RefContext {
  slug: string;
  /** Where a name is documented: the current package when it has it. A name
   *  an export was declared under (`EditorApi`) resolves to what it is exported
   *  as (`Editor`). */
  resolve(name: string): { slug: string; anchor: string } | null;
  go(slug: string, anchor: string): void;
}
const Ref = createContext<RefContext | null>(null);

/** A link to another row of the reference; plain children when the name is
 *  not an export the reference documents. */
function RefLink({ name, children }: { name: string; children: ReactNode }) {
  const ref = useContext(Ref);
  const found = ref?.resolve(name);
  if (!ref || !found) return <>{children}</>;
  const { slug, anchor } = found;
  function onClick(e: MouseEvent<HTMLAnchorElement>) {
    // Leave "open in a new tab" to the browser.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    ref!.go(slug, anchor);
  }
  return (
    <a className="dx-ref-link" href={hrefOf(slug, anchor)} onClick={onClick}>
      {children}
    </a>
  );
}

/* ── signatures ── */

/** A signature as written in the source, with keywords tinted and every type
 *  the reference documents turned into a link. Only capitalised names are
 *  linked: a lower-case one is far more often a parameter than an export. */
function sigTokens(text: string, self: string): ReactNode[] {
  const re =
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|([A-Za-z_$][\w$]*)|(\d[\w.]*)|(\s+)|([\s\S])/g;
  const out: ReactNode[] = [];
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    const key = i++;
    if (m[1]) {
      out.push(
        <span key={key} className="tok-com">
          {m[1]}
        </span>,
      );
    } else if (m[2]) {
      out.push(
        <span key={key} className="tok-str">
          {m[2]}
        </span>,
      );
    } else if (m[3]) {
      const word = m[3];
      if (SIG_KEYWORDS.has(word)) {
        out.push(
          <span key={key} className="tok-kw">
            {word}
          </span>,
        );
      } else if (word !== self && /^[A-Z]/.test(word)) {
        out.push(
          <RefLink key={key} name={word}>
            {word}
          </RefLink>,
        );
      } else {
        out.push(word);
      }
    } else {
      out.push(m[0]);
    }
  }
  return out;
}

function Sig({ text, self }: { text: string; self: string }) {
  return (
    <pre className="dx-ref-sig">
      <code>{sigTokens(text, self)}</code>
    </pre>
  );
}

/** What a signature says about one parameter: its type, and whether a caller
 *  may leave it out. Read off the signature text, so a type too long to sit
 *  beside the name is dropped — the signature above still shows it. */
function paramOf(
  sigs: string[],
  name: string,
): { type: string; optional: boolean } | null {
  const bare = name.replace(/^\.\.\./, "");
  if (!/^[\w$]+$/.test(bare)) return null;
  const at = new RegExp(`(?:^|[(,\\s.])${bare.replace(/\$/g, "\\$")}(\\?)?\\s*:\\s*`);
  let found: { type: string; optional: boolean } | null = null;
  let absent = false;
  for (const sig of sigs) {
    const m = at.exec(sig);
    if (!m) {
      absent = true;
      continue;
    }
    if (found) continue;
    const start = m.index + m[0].length;
    let i = start;
    let depth = 0;
    for (; i < sig.length; i++) {
      const c = sig[i];
      if (c === "=" && sig[i + 1] === ">") {
        i++;
      } else if ("([{<".includes(c)) {
        depth++;
      } else if (")]}>".includes(c)) {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && (c === "," || c === "=")) {
        break;
      }
    }
    const type = sig.slice(start, i).trim();
    found = {
      type: type.includes("\n") || type.length > 48 ? "" : type,
      optional: Boolean(m[1]) || sig[i] === "=",
    };
  }
  // A parameter only some overloads take is optional to the caller.
  return found ? { type: found.type, optional: found.optional || absent } : null;
}

/* ── doc comments ── */

/** The export an inline code span names: `createEditor()`, `Node.layout`. */
function nameIn(code: string): string | null {
  const head = code.replace(/^new\s+/, "").split(/[.#(<\s]/)[0];
  return /^[A-Za-z_$][\w$]*$/.test(head) ? head : null;
}

/** `inLink` is set for everything inside a link, where a name must stay plain
 *  code: a link cannot hold another link. */
function Md({
  nodes,
  self,
  inLink = false,
}: {
  nodes: MdNode[];
  self: string;
  inLink?: boolean;
}): ReactNode {
  return nodes.map((node, i) => (
    <MdItem key={i} node={node} self={self} inLink={inLink} />
  ));
}

function MdItem({
  node,
  self,
  inLink,
}: {
  node: MdNode;
  self: string;
  inLink: boolean;
}): ReactNode {
  const kids = node.children ? (
    <Md nodes={node.children} self={self} inLink={inLink || node.type === "link"} />
  ) : null;
  switch (node.type) {
    case "text":
      return node.value;
    case "paragraph":
      return <p>{kids}</p>;
    case "inlineCode": {
      const code = <code>{node.value}</code>;
      const name = nameIn(node.value ?? "");
      return name && name !== self && !inLink ? (
        <RefLink name={name}>{code}</RefLink>
      ) : (
        code
      );
    }
    case "strong":
      return <strong>{kids}</strong>;
    case "emphasis":
      return <em>{kids}</em>;
    case "delete":
      return <del>{kids}</del>;
    case "break":
      return <br />;
    case "link": {
      const url = node.url ?? "";
      if (url.startsWith("ref:")) {
        const name = url.slice(4);
        return name === self ? kids : <RefLink name={name}>{kids}</RefLink>;
      }
      return (
        <a href={url} target="_blank" rel="noreferrer">
          {kids}
        </a>
      );
    }
    case "list":
      return node.ordered ? <ol>{kids}</ol> : <ul>{kids}</ul>;
    case "listItem":
      return <li>{kids}</li>;
    case "blockquote":
      return <blockquote>{kids}</blockquote>;
    // A heading inside a comment is emphasis, not page structure: the page's
    // own headings feed the table of contents.
    case "heading":
      return (
        <p>
          <strong>{kids}</strong>
        </p>
      );
    case "code":
      return <Code code={node.value ?? ""} lang={node.lang ?? "ts"} />;
    case "table":
      return (
        <div className="dx-ref-table">
          <table>
            <tbody>{kids}</tbody>
          </table>
        </div>
      );
    case "tableRow":
      return <tr>{kids}</tr>;
    case "tableCell":
      return <td>{kids}</td>;
    default:
      return kids;
  }
}

/** A one-line summary: plain text with its inline code kept as code. */
function Summary({ text }: { text: string }) {
  return text
    .split("`")
    .map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));
}

/* ── badges ── */

function Badges({ item, optional }: { item: ApiDocFields; optional?: boolean }) {
  const { t } = useTranslation();
  const unreleased = item.since ? isNewer(item.since, INDEX.version) : false;
  if (!item.since && !item.deprecated && !item.experimental && !optional) return null;
  return (
    <span className="dx-ref-badges">
      {optional ? (
        <span className="dx-ref-badge">{t("docs.ref.optional", "Optional")}</span>
      ) : null}
      {item.since ? (
        unreleased ? (
          <span
            className="dx-ref-badge is-unreleased"
            title={t("docs.ref.unreleasedHint", "Arrives in version {{version}}", {
              version: item.since,
            })}
          >
            {t("docs.ref.unreleased", "Unreleased")}
          </span>
        ) : (
          <span className="dx-ref-badge is-since">
            {t("docs.ref.since", "Since {{version}}", { version: item.since })}
          </span>
        )
      ) : null}
      {item.experimental ? (
        <span className="dx-ref-badge is-experimental">
          {t("docs.ref.experimental", "Experimental")}
        </span>
      ) : null}
      {item.deprecated ? (
        <span className="dx-ref-badge is-deprecated">
          {t("docs.ref.deprecated", "Deprecated")}
        </span>
      ) : null}
    </span>
  );
}

/* ── the parts of a doc comment: prose, then parameters, return value, examples ── */

function Prose({ item, self }: { item: ApiDocFields; self: string }) {
  return (
    <>
      {Array.isArray(item.deprecated) ? (
        <div className="dx-ref-note">
          <Md nodes={item.deprecated} self={self} />
        </div>
      ) : null}
      {item.doc ? (
        <div className="dx-ref-doc">
          <Md nodes={item.doc} self={self} />
        </div>
      ) : null}
    </>
  );
}

/** `sigs` are the signatures the parameters belong to: their types come from there. */
function Details({
  item,
  self,
  sigs,
}: {
  item: ApiDocFields;
  self: string;
  sigs: string[];
}) {
  const { t } = useTranslation();
  const returns = item.returns ? <Md nodes={item.returns} self={self} /> : null;
  return (
    <>
      {item.default ? (
        <p className="dx-ref-default">
          <span className="dx-ref-label">{t("docs.ref.default", "Default")}</span>
          <code>{item.default}</code>
        </p>
      ) : null}
      {item.params?.length ? (
        <div className="dx-ref-block">
          <div className="dx-ref-label">{t("docs.ref.parameters", "Parameters")}</div>
          <dl className="dx-ref-params">
            {item.params.map((param) => {
              const declared = paramOf(sigs, param.name);
              return (
                <div key={param.name}>
                  <dt>
                    <code>{param.name}</code>
                    {declared?.type ? (
                      <code className="dx-ref-ptype">{sigTokens(declared.type, self)}</code>
                    ) : null}
                    {declared?.optional ? (
                      <span className="dx-ref-opt">
                        {t("docs.ref.optional", "Optional")}
                      </span>
                    ) : null}
                  </dt>
                  <dd>
                    <Md nodes={param.doc} self={self} />
                  </dd>
                </div>
              );
            })}
            {/* The return value closes the parameter table. */}
            {returns ? (
              <div>
                <dt className="is-plain">{t("docs.ref.returns", "Returns")}</dt>
                <dd>{returns}</dd>
              </div>
            ) : null}
          </dl>
        </div>
      ) : returns ? (
        <div className="dx-ref-block">
          <div className="dx-ref-label">{t("docs.ref.returns", "Returns")}</div>
          <div className="dx-ref-doc">{returns}</div>
        </div>
      ) : null}
      {item.examples?.map((example, i) => (
        <div className="dx-ref-block" key={i}>
          <div className="dx-ref-label">
            {example.title ?? t("docs.ref.example", "Example")}
          </div>
          <Code code={example.code} lang={example.lang} />
        </div>
      ))}
    </>
  );
}

/* ── one member of a class, interface or object type ── */

function Member({ member, owner, id }: { member: ApiMember; owner: string; id?: string }) {
  return (
    <div className="dx-ref-member" id={id}>
      <div className="dx-ref-member-head">
        <Sig text={member.sig} self={owner} />
        <Badges item={member} optional={member.optional} />
      </div>
      <Prose item={member} self={owner} />
      <Details item={member} self={owner} sigs={[member.sig]} />
    </div>
  );
}

/* ── one export ── */

function importLine(symbol: ApiSymbol, from: string) {
  const typeOnly = symbol.kind === "interface" || symbol.kind === "type";
  return `import ${typeOnly ? "type " : ""}{ ${symbol.name} } from "${from}";`;
}

/** A line of code to copy as it stands. */
function CopyLine({ text }: { text: string }) {
  return (
    <div className="dx-ref-copyline">
      <code>{text}</code>
      <CopyBtn text={text} />
    </div>
  );
}

/** Copies the address of one export, so it can be pasted into a message. */
function CopyLink({ anchor }: { anchor: string }) {
  const { t } = useTranslation();
  const ref = useContext(Ref);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 1600);
    return () => clearTimeout(timer);
  }, [done]);
  function copy() {
    try {
      const url = new URL(window.location.href);
      url.search = "";
      url.hash = "";
      void navigator.clipboard
        ?.writeText(url.toString() + hrefOf(ref?.slug ?? DEFAULT_SLUG, anchor))
        .catch(() => {});
    } catch {
      /* no clipboard: the address bar already holds the link */
    }
    // Opening the row put this address in the URL; say so either way.
    setDone(true);
  }
  return (
    <button type="button" className="dx-ref-linkbtn" onClick={copy}>
      {done
        ? t("docs.ref.linkCopied", "Link copied")
        : t("docs.ref.copyLink", "Copy link to this export")}
    </button>
  );
}

function SymbolBody({ symbol }: { symbol: ApiSymbol }) {
  const { t } = useTranslation();
  const anchor = anchorOf(symbol);
  const seen = new Set<string>();
  const overloads = symbol.sigs.length;
  return (
    <div className="dx-ref-body">
      {symbol.doc || symbol.deprecated ? (
        <Prose item={symbol} self={symbol.name} />
      ) : (
        <p className="dx-ref-empty">{t("docs.ref.noDoc", "No description yet.")}</p>
      )}
      <div className="dx-ref-block">
        <div className="dx-ref-label">{t("docs.ref.import", "Import")}</div>
        <CopyLine text={importLine(symbol, symbol.from[0])} />
      </div>
      {overloads ? (
        <div className="dx-ref-block">
          <div className="dx-ref-label">
            {overloads > 1
              ? `${t("docs.ref.signatures", "Signatures")} · ${t(
                  "docs.ref.overloads",
                  "{{count}} overloads",
                  { count: overloads },
                )}`
              : t("docs.ref.signature", "Signature")}
          </div>
          <div className="dx-ref-sigs">
            {symbol.sigs.map((sig, i) => (
              <Sig key={i} text={sig} self={symbol.name} />
            ))}
          </div>
        </div>
      ) : null}
      <Details item={symbol} self={symbol.name} sigs={symbol.sigs} />
      {symbol.members?.length ? (
        <div className="dx-ref-block">
          <div className="dx-ref-label">{t("docs.ref.members", "Members")}</div>
          <div className="dx-ref-members">
            {symbol.members.map((member, i) => {
              // Overloads share a name; only the first can own the anchor.
              const first = !seen.has(member.name);
              seen.add(member.name);
              return (
                <Member
                  key={i}
                  member={member}
                  owner={symbol.name}
                  id={first ? `${anchor}.${member.name}` : undefined}
                />
              );
            })}
          </div>
        </div>
      ) : null}
      <div className="dx-ref-foot">
        {symbol.src ? (
          <a href={`${REPO_URL}/blob/main/${symbol.src}`} target="_blank" rel="noreferrer">
            {t("docs.ref.source", "View source")}
          </a>
        ) : null}
        <CopyLink anchor={anchor} />
        {symbol.from.length > 1 ? (
          <span>
            {t("docs.ref.alsoFrom", "Also exported from")}{" "}
            {symbol.from.slice(1).map((entry, i) => (
              <span key={entry}>
                {i ? ", " : null}
                <code>{entry}</code>
              </span>
            ))}
          </span>
        ) : null}
      </div>
    </div>
  );
}

const Row = memo(function Row({
  symbol,
  open,
  onToggle,
}: {
  symbol: ApiSymbol;
  open: boolean;
  onToggle: (anchor: string) => void;
}) {
  const { t } = useTranslation();
  const anchor = anchorOf(symbol);
  return (
    <li className={"dx-ref-row" + (open ? " is-open" : "")} id={anchor}>
      <button
        type="button"
        className="dx-ref-row-head"
        aria-expanded={open}
        onClick={() => onToggle(anchor)}
      >
        <Icons.ChevronRight className="dx-ref-chevron" />
        <span className={"dx-ref-kind k-" + symbol.kind}>{KIND_TAG[symbol.kind]}</span>
        <code className="dx-ref-name">{symbol.name}</code>
        <Badges item={symbol} />
        {symbol.summary ? (
          <span className="dx-ref-summary">
            <Summary text={symbol.summary} />
          </span>
        ) : null}
        {symbol.sigs.length > 1 ? (
          <span className="dx-ref-row-meta">
            {t("docs.ref.overloads", "{{count}} overloads", {
              count: symbol.sigs.length,
            })}
          </span>
        ) : null}
      </button>
      {open ? <SymbolBody symbol={symbol} /> : null}
    </li>
  );
});

/* ── the page ── */

interface Group {
  id: string;
  title: string;
  mono: boolean;
  symbols: ApiSymbol[];
}

function matches(symbol: ApiSymbol, query: string) {
  if (symbol.name.toLowerCase().includes(query)) return true;
  return symbol.members?.some((m) => m.name.toLowerCase().includes(query)) ?? false;
}

const withItem = (set: ReadonlySet<string>, item: string) => new Set(set).add(item);

export default function ApiReferenceView() {
  const { t } = useTranslation();
  const [slug, setSlug] = useState(DEFAULT_SLUG);
  const [loaded, setLoaded] = useState<Record<string, ApiPackage>>({
    [DEFAULT_SLUG]: PRELOADED,
  });
  const [failed, setFailed] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [allOpen, setAllOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<ApiKind | "all">("all");
  /** The group that is unfolded; none chosen means the first one. */
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  /** Groups listed in full, past their first page. */
  const [full, setFull] = useState<ReadonlySet<string>>(new Set());
  /** The anchor to open and scroll to — from the URL or a link on the page —
   *  until that has happened. */
  const [target, setTarget] = useState<string | null>(null);

  // The URL is read after mount (and again on back/forward), so the prerendered
  // HTML and the first client render agree — as the docs' other switchers do.
  useEffect(() => {
    function sync() {
      const next = readLocation();
      setSlug(next.slug);
      setTarget(next.target);
    }
    sync();
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);

  // Packages other than the default arrive on demand, one file each.
  const data = loaded[slug];
  useEffect(() => {
    if (data) return;
    let stale = false;
    import(`./data/${slug}.json`)
      .then((mod: { default: unknown }) => {
        if (stale) return;
        setLoaded((prev) => ({ ...prev, [slug]: mod.default as ApiPackage }));
      })
      .catch(() => {
        if (!stale) setFailed(slug);
      });
    return () => {
      stale = true;
    };
  }, [data, slug]);

  const groups = useMemo<Group[]>(() => {
    if (!data) return [];
    const [root, ...rest] = data.entries;
    const out: Group[] = [];
    for (const kind of KIND_ORDER) {
      const symbols = root.symbols.filter((s) => s.kind === kind);
      if (symbols.length) {
        out.push({
          id: GROUP_PREFIX + kind,
          title: t(`docs.ref.kind.${kind}`),
          mono: false,
          symbols,
        });
      }
    }
    // What only a secondary entry exports is listed under that entry.
    for (const entry of rest) {
      if (entry.symbols.length) {
        out.push({
          id: entryGroupId(entry.id),
          title: entry.id,
          mono: true,
          symbols: entry.symbols,
        });
      }
    }
    return out;
  }, [data, t]);

  // Bring the target on screen: unfold its group, open its row, scroll to it
  // (or to one of its members).
  useEffect(() => {
    if (!target || !data) return;
    let scrollTo = target;
    if (target.startsWith(GROUP_PREFIX)) {
      const group = groups.find((g) => g.id === target);
      if (group) {
        setQuery("");
        // Keep the kind chip unless it would leave this group empty.
        setKind((k) => (k === "all" || group.symbols.some((s) => s.kind === k) ? k : "all"));
        setOpenGroup(target);
      }
    } else {
      const owner = target.split(".")[0];
      const home = groups.find((group) =>
        group.symbols.some((symbol) => anchorOf(symbol) === owner),
      );
      setQuery("");
      setKind("all");
      if (home) {
        setOpenGroup(home.id);
        setFull((prev) => withItem(prev, home.id));
      }
      setOpen((prev) => withItem(prev, owner));
      if (!document.getElementById(target)) scrollTo = owner;
    }
    const frame = requestAnimationFrame(() => {
      const el = document.getElementById(target) ?? document.getElementById(scrollTo);
      el?.scrollIntoView({ block: "start" });
      setTarget(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, data, groups]);

  const ref = useMemo<RefContext>(() => {
    const owners = new Map<string, { slug: string; anchor: string }[]>();
    const add = (name: string, slug: string, anchor: string) => {
      const list = owners.get(name);
      if (list) list.push({ slug, anchor });
      else owners.set(name, [{ slug, anchor }]);
    };
    for (const pkg of INDEX.packages) {
      for (const name of pkg.names) add(name, pkg.slug, name);
      for (const [declared, exported] of Object.entries(pkg.aliases)) {
        add(declared, pkg.slug, exported);
      }
    }
    return {
      slug,
      resolve(name) {
        const list = owners.get(name);
        if (!list) return null;
        return list.find((o) => o.slug === slug) ?? list[0];
      },
      go(nextSlug, anchor) {
        writeLocation(nextSlug, anchor, true);
        setSlug(nextSlug);
        setTarget(anchor);
      },
    };
  }, [slug]);

  const pick = useCallback((next: string) => {
    writeLocation(next, null);
    setSlug(next);
    setOpen(new Set());
    setAllOpen(false);
    setQuery("");
    setKind("all");
    setOpenGroup(null);
    setFull(new Set());
    setFailed(null);
  }, []);

  // What `toggle` reads, kept in a ref so the rows' callback stays the same
  // from one render to the next.
  const rows = useRef({ open, allOpen });
  useEffect(() => {
    rows.current = { open, allOpen };
  }, [open, allOpen]);
  const toggle = useCallback(
    (anchor: string) => {
      const listed = rows.current.open.has(anchor);
      // "Expand all" turns the set into the rows that are closed.
      const opening = rows.current.allOpen ? listed : !listed;
      setOpen((prev) => {
        const next = new Set(prev);
        if (next.has(anchor)) next.delete(anchor);
        else next.add(anchor);
        return next;
      });
      // Opening a row makes it the page's address, so it can be shared.
      if (opening) writeLocation(slug, anchor);
    },
    [slug],
  );

  const q = query.trim().toLowerCase();
  const total = groups.reduce((n, group) => n + group.symbols.length, 0);
  /** How many exports each kind has, across every entry of the package. */
  const kindCounts = useMemo(() => {
    const counts = new Map<ApiKind, number>();
    for (const group of groups) {
      for (const symbol of group.symbols) {
        counts.set(symbol.kind, (counts.get(symbol.kind) ?? 0) + 1);
      }
    }
    return counts;
  }, [groups]);
  /** The groups after the kind chips, and what of each the name filter keeps. */
  const visible = useMemo(
    () =>
      groups
        .map((group) => {
          const ofKind =
            kind === "all" ? group.symbols : group.symbols.filter((s) => s.kind === kind);
          return {
            ...group,
            size: ofKind.length,
            symbols: q ? ofKind.filter((s) => matches(s, q)) : ofKind,
          };
        })
        .filter((group) => group.symbols.length > 0),
    [groups, kind, q],
  );
  // A search shows every group that has a match; otherwise one group is open.
  const current = q
    ? null
    : (visible.find((group) => group.id === openGroup) ?? visible[0])?.id;
  const meta = INDEX.packages.find((p) => p.slug === slug)!;
  const [major, minor] = INDEX.version.split(".");

  const blocks: ReactNode[] = [];
  let folds: typeof visible = [];
  function flushFolds() {
    if (!folds.length) return;
    blocks.push(
      <div className="dx-ref-folds" key={"folds:" + folds[0].id}>
        {folds.map((group) => (
          <h2
            key={group.id}
            id={group.id}
            className={"dx-ref-fold" + (group.mono ? " is-entry" : "")}
          >
            <button type="button" aria-expanded={false} onClick={() => setTarget(group.id)}>
              <Icons.ChevronRight className="dx-ref-chevron" />
              {/* The count is drawn by CSS, so the table of contents (which
                  reads the heading's text) lists the title alone. */}
              <span className="dx-ref-fold-label" data-count={group.size}>
                {group.title}
              </span>
            </button>
          </h2>
        ))}
      </div>,
    );
    folds = [];
  }
  for (const group of visible) {
    if (!q && group.id !== current) {
      folds.push(group);
      continue;
    }
    flushFolds();
    const paged = !q && !full.has(group.id) && group.symbols.length > PAGE;
    const listed = paged ? group.symbols.slice(0, PAGE) : group.symbols;
    blocks.push(
      <div className="dx-ref-group" key={group.id}>
        <div className="dx-ref-group-head">
          <h2
            id={group.id}
            className={group.mono ? "dx-ref-entry" : undefined}
            data-count={group.size}
          >
            {group.title}
          </h2>
          {q ? (
            <span className="dx-ref-count">
              {t("docs.ref.matching", "Matches: {{count}}", { count: listed.length })}
            </span>
          ) : paged ? (
            <span className="dx-ref-count">
              {t("docs.ref.showing", "Showing {{shown}} of {{total}}", {
                shown: listed.length,
                total: group.symbols.length,
              })}
            </span>
          ) : null}
        </div>
        <ul className="dx-ref-list">
          {listed.map((symbol) => {
            const anchor = anchorOf(symbol);
            return (
              <Row
                key={anchor}
                symbol={symbol}
                open={allOpen ? !open.has(anchor) : open.has(anchor)}
                onToggle={toggle}
              />
            );
          })}
        </ul>
        {paged ? (
          <button
            type="button"
            className="dx-ref-btn is-sm"
            onClick={() => setFull((prev) => withItem(prev, group.id))}
          >
            {t("docs.ref.showAll", "Show all {{count}}", { count: group.symbols.length })}
          </button>
        ) : null}
      </div>,
    );
  }
  flushFolds();

  return (
    <Ref.Provider value={ref}>
      <div className="dx-ref">
        <div className="dx-ref-legend">
          <span>
            <span className="dx-ref-badge is-since">
              {t("docs.ref.since", "Since {{version}}", { version: `${major}.${minor}.x` })}
            </span>
            {t("docs.ref.legend.since", "added after the first tracked version")}
          </span>
          <span>
            <span className="dx-ref-badge is-unreleased">
              {t("docs.ref.unreleased", "Unreleased")}
            </span>
            {t("docs.ref.legend.unreleased", "not on npm yet")}
          </span>
        </div>

        <section className="dx-ref-section" aria-label={t("docs.ref.packages", "Packages")}>
          <div className="dx-ref-intro">
            <h2 id={PACKAGES_ANCHOR} data-count={INDEX.packages.length}>
              {t("docs.ref.choose.title", "Choose a package")}
            </h2>
            <p>
              {t(
                "docs.ref.choose.hint",
                "The list below shows the exports of the package you pick.",
              )}
            </p>
          </div>
          <div
            className="dx-ref-pkgs"
            role="group"
            aria-label={t("docs.ref.packages", "Packages")}
          >
            {PKG_GROUPS.map((group) => {
              const packages = INDEX.packages.filter((p) => pkgGroupOf(p.slug) === group);
              if (!packages.length) return null;
              return (
                <div className="dx-ref-pkgrow" key={group}>
                  <span className="dx-ref-pkgrow-label">{t(`docs.ref.group.${group}`)}</span>
                  <div className="dx-ref-pkgrow-cards">
                    {packages.map((pkg) => {
                      const cut = pkg.name.indexOf("/") + 1;
                      return (
                        <button
                          key={pkg.slug}
                          type="button"
                          className={"dx-ref-pkg" + (pkg.slug === slug ? " is-active" : "")}
                          aria-pressed={pkg.slug === slug}
                          onClick={() => pick(pkg.slug)}
                        >
                          <span className="dx-ref-pkg-name">
                            <bdi dir="ltr">
                              <span className="dx-ref-scope">{pkg.name.slice(0, cut)}</span>
                              {pkg.name.slice(cut)}
                            </bdi>
                          </span>
                          {pkg.description ? (
                            <span className="dx-ref-pkg-desc" dir="auto">
                              {pkg.description}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="dx-ref-pkgcard">
            <div className="dx-ref-pkgcard-head">
              <h2 className="dx-ref-pkg-title">
                <bdi dir="ltr">{meta.name}</bdi>
              </h2>
              {meta.description ? <span dir="auto">{meta.description}</span> : null}
            </div>
            <dl className="dx-ref-facts">
              <div>
                <dt>{t("docs.ref.versionLabel", "Version")}</dt>
                <dd className="is-version">{INDEX.version}</dd>
              </div>
              <div>
                <dt>{t("docs.ref.exports", "Exports")}</dt>
                <dd>{meta.names.length}</dd>
              </div>
              {meta.entries.length > 1 ? (
                <div className="is-wide">
                  <dt>{t("docs.ref.entryPoints", "Entry points")}</dt>
                  <dd className="is-entries">
                    {meta.entries.map((entry, i) => {
                      // The package's own entry holds the kind groups; the
                      // others have a group each, when they add anything.
                      const id = i === 0 ? groups[0]?.id : entryGroupId(entry);
                      const label = i === 0 ? entry : entry.slice(meta.name.length);
                      return id && groups.some((group) => group.id === id) ? (
                        <a
                          key={entry}
                          href={"#" + id}
                          onClick={(e) => {
                            e.preventDefault();
                            setTarget(id);
                          }}
                        >
                          {label}
                        </a>
                      ) : (
                        <span key={entry}>{label}</span>
                      );
                    })}
                  </dd>
                </div>
              ) : null}
            </dl>
            {/* The same chooser as the install page: it remembers the reader's
                package manager, here and there. */}
            <InstallTabs pkg={meta.name} />
          </div>
        </section>

        <section className="dx-ref-section" aria-label={t("docs.ref.exports", "Exports")}>
          <div className="dx-ref-tools">
            <div className="dx-ref-filter">
              <Icons.Search />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("docs.ref.filter.placeholder", "Filter by name…")}
                aria-label={t("docs.ref.filter.label", "Filter exports")}
              />
            </div>
            <button
              type="button"
              className="dx-ref-btn"
              onClick={() => {
                setAllOpen((v) => !v);
                setOpen(new Set());
              }}
            >
              {allOpen
                ? t("docs.ref.collapseAll", "Collapse all")
                : t("docs.ref.expandAll", "Expand all")}
            </button>
          </div>

          {data ? (
            <div
              className="dx-ref-kinds"
              role="group"
              aria-label={t("docs.ref.kinds.label", "Filter by kind")}
            >
              <button
                type="button"
                className={"dx-ref-chip" + (kind === "all" ? " is-active" : "")}
                aria-pressed={kind === "all"}
                onClick={() => {
                  setKind("all");
                  setOpenGroup(null);
                }}
              >
                {t("docs.ref.kinds.all", "All")}
                <span>{total}</span>
              </button>
              {KIND_ORDER.filter((k) => kindCounts.has(k)).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={"dx-ref-chip" + (kind === k ? " is-active" : "")}
                  aria-pressed={kind === k}
                  onClick={() => {
                    setKind(k);
                    setOpenGroup(null);
                  }}
                >
                  {t(`docs.ref.kind.${k}`)}
                  <span>{kindCounts.get(k)}</span>
                </button>
              ))}
            </div>
          ) : null}

          {!data ? (
            <p className="dx-ref-empty">
              {failed === slug
                ? t(
                    "docs.ref.loadFailed",
                    "Couldn't load this package. Reload the page to try again.",
                  )
                : t("docs.ref.loading", "Loading…")}
            </p>
          ) : null}

          {data && visible.length === 0 ? (
            <p className="dx-ref-empty is-card">
              {t("docs.ref.filter.empty", "No exports match “{{query}}”.", { query })}{" "}
              {t("docs.ref.filter.emptyHint", "Clear the filter or try another kind.")}
            </p>
          ) : null}

          {blocks}
        </section>
      </div>
    </Ref.Provider>
  );
}
