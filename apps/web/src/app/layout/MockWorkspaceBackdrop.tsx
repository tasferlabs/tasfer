/*
 * MockWorkspaceBackdrop — what sits behind the first-run onboarding dialog.
 *
 * The live app shell used to render here, which meant the editor route mounted
 * with no space to load: it flashed its loading skeletons and then settled on a
 * "No pages found" state whose only button could not work. A detailed still
 * life of the shell replaced it, but that competed with the dialog for
 * attention. What is left is a wireframe: the shape of the app — a sidebar of
 * rows, a header, an open document — drawn as placeholder bars and blurred, so
 * it reads as "your workspace goes here" without anything to read.
 *
 * It carries no words, so no locale has anything to translate. No queries, no
 * state, no animation. Nothing here is reachable: the tree is `inert`, hidden
 * from assistive tech, and non-interactive down at the CSS level.
 */

import mock from "./MockWorkspaceBackdrop.module.css";

/** A placeholder text bar, `width` as a percentage of its row. */
function Bar({
  width,
  className = mock.bar,
}: {
  width: number;
  className?: string;
}) {
  return <span className={className} style={{ width: `${width}%` }} />;
}

/** A sidebar nav or space row: an icon square and a label bar. */
function Row({ width }: { width: number }) {
  return (
    <div className={mock.row}>
      <span className={mock.rowIcon} />
      <Bar width={width} />
    </div>
  );
}

/**
 * A page row. Pages have no icons; only a page with sub-pages carries a dot,
 * as in the real tree.
 */
function PageRow({
  width,
  hasChildren = false,
}: {
  width: number;
  hasChildren?: boolean;
}) {
  return (
    <div className={mock.pageRow}>
      <span className={mock.pageDot} data-visible={hasChildren || undefined} />
      <Bar width={width} />
    </div>
  );
}

/** A paragraph of bars; the last line runs short, like real text. */
function Paragraph({ lines }: { lines: number[] }) {
  return (
    <div className={mock.paragraph}>
      {lines.map((width, i) => (
        <Bar key={i} width={width} className={mock.line} />
      ))}
    </div>
  );
}

export function MockWorkspaceBackdrop() {
  return (
    <div className={mock.root} aria-hidden="true" inert>
      <div className={mock.shell}>
        <aside className={mock.sidebar}>
          <div className={mock.brand}>
            <span className={mock.brandMark} />
            <Bar width={46} />
          </div>

          <div className={mock.group}>
            {[38, 52, 44, 58].map((width, i) => (
              <Row key={i} width={width} />
            ))}
          </div>

          <div className={mock.group}>
            <Row width={48} />
            <PageRow width={62} hasChildren />
            {[40, 70, 54].map((width, i) => (
              <PageRow key={i} width={width} />
            ))}
            <Row width={36} />
            {[50, 66].map((width, i) => (
              <PageRow key={i} width={width} />
            ))}
          </div>
        </aside>

        <main className={mock.frame}>
          <div className={mock.header}>
            <Bar width={9} />
            <Bar width={13} />
            <span className={mock.headerSpacer} />
            <span className={mock.headerButton} />
            <span className={mock.headerButton} />
          </div>

          <div className={mock.cover} />

          <div className={mock.doc}>
            <Bar width={58} className={mock.title} />
            <Bar width={34} className={mock.subtitle} />

            <Paragraph lines={[100, 96, 88, 62]} />

            {/* Where the real page shows off an equation. */}
            <div className={mock.block}>
              <Bar width={38} className={mock.blockBar} />
            </div>

            <Paragraph lines={[98, 91, 44]} />

            <div className={mock.cards}>
              {[0, 1, 2].map((i) => (
                <div key={i} className={mock.card}>
                  <Bar width={64} />
                  <Bar width={42} className={mock.cardLine} />
                </div>
              ))}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
