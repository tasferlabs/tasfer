/*
 * MockWorkspaceBackdrop — what sits behind the first-run onboarding dialog.
 *
 * The live app shell used to render here, which meant the editor route mounted
 * with no space to load: it flashed its loading skeletons and then settled on a
 * "No pages found" state whose only button could not work. This replaces it
 * with a still life of the same shell — the sidebar, a space list, an open
 * document — assembled from the real layout classes so the proportions can
 * never drift, and drawn exactly once. No queries, no state, no animation, so
 * there is nothing left that can flash.
 *
 * Nothing here is reachable: the tree is `inert`, hidden from assistive tech,
 * and non-interactive down at the CSS level.
 */

import { Archive, Ellipsis, Plus, Search } from "lucide-react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { isApplePlatform } from "@tasfer/editor";
import clsx from "clsx";
import Icons from "../components/uiKit/Icons/Icons";
import style from "./Layout.module.css";
import pageStyle from "./components/PagesLinks.module.css";
import mock from "./MockWorkspaceBackdrop.module.css";

/** One space header, drawn open or collapsed. */
function MockSpace({ name, open }: { name: string; open: boolean }) {
  return (
    <div className={style.appSidebarSection}>
      <span className={clsx(style.appSidebarSectionHandle, "justify-start")}>
        <span className={style.appSidebarSectionTitle}>
          <span className={style.appSidebarSectionIcon}>
            <Icons.Box className={style.appSidebarSpaceGlyph} />
            <Icons.ChevronRight
              className={clsx(
                style.appSidebarCollapseIcon,
                open && style.appSidebarCollapseIconOpen,
              )}
            />
          </span>
          <span className="truncate">{name}</span>
        </span>
      </span>
      <span className={style.appSidebarSectionButton}>
        <Ellipsis className="size-5" />
      </span>
      <span className={style.appSidebarSectionButton}>
        <Plus className="size-5" />
      </span>
    </div>
  );
}

/**
 * One page row. Only a page with sub-pages carries the dot, exactly as in the
 * real tree — the marker means something rather than decorating every row. No
 * row is drawn active: the primary tint belongs to the dialog on top.
 */
function MockPage({
  title,
  hasChildren = false,
}: {
  title: string;
  hasChildren?: boolean;
}) {
  return (
    <div className={pageStyle.link}>
      {hasChildren && (
        <span
          className={clsx(
            pageStyle.action,
            pageStyle.collapseAction,
            pageStyle.hasChildren,
          )}
          style={
            { "--page-blob-color": "var(--page-color-default)" } as CSSProperties
          }
        >
          <span
            className={clsx(
              pageStyle.collapseBlob,
              pageStyle.collapseBlobDefault,
            )}
          />
        </span>
      )}
      <div className={pageStyle.linkTitle}>
        <span>{title}</span>
      </div>
    </div>
  );
}

function MockNavRow({
  icon,
  label,
  shortcut,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
}) {
  return (
    <span className={clsx(style.appNavigationLink, "justify-start font-normal")}>
      <span className={style.appNavigationLinkIcon}>{icon}</span>
      {label}
      {shortcut && (
        <kbd className={style.appNavigationLinkShortcut}>{shortcut}</kbd>
      )}
    </span>
  );
}

export function MockWorkspaceBackdrop() {
  const { t } = useTranslation();

  const research = t("sample.spaceResearch", "Research");
  const openPage = t("sample.pageProbability", "Probability");

  return (
    <div className={mock.root} aria-hidden="true" inert>
      <div className={style.appContainer}>
        <div className={style.appSidebar} style={{ width: 268 }}>
          <div className={style.appSidebarContent}>
            <div className={style.appNavigationLinks}>
              <MockNavRow
                icon={<Search size={20} />}
                label={t("sidebar.search", "Search")}
                shortcut={isApplePlatform() ? "⌘K" : "Ctrl+K"}
              />
              <MockNavRow
                icon={<Icons.Gear width={24} height={24} />}
                label={t("settings.title", "Settings")}
              />
              <MockNavRow
                icon={<Icons.Calendar width={24} height={24} />}
                label={t("calendar.title", "Calendar")}
              />
              <MockNavRow
                icon={<Archive width={24} height={24} />}
                label={t("archive.title", "Archive")}
              />
              <MockNavRow
                icon={<Icons.AddGroup />}
                label={t("space.addSpace", "Add space")}
              />
            </div>

            <div className={style.appSidebarMain}>
              <div>
                <MockSpace name={research} open />
                <div className={style.appSidebarPages}>
                  <MockPage title={openPage} hasChildren />
                  <div className={pageStyle.accordion}>
                    <MockPage
                      title={t("sample.pageDistributions", "Distributions")}
                    />
                    <MockPage
                      title={t("sample.pageOpenQuestions", "Open questions")}
                    />
                  </div>
                  <MockPage
                    title={t("sample.pageReadingList", "Reading list")}
                  />
                </div>
                <MockSpace
                  name={t("common.personal", "Personal")}
                  open={false}
                />
                <div className={style.appSidebarTail} />
              </div>
            </div>
          </div>
          <div className={style.appSidebarResizer} />
        </div>

        <div className={style.appFrame}>
          <div className={style.appHeader}>
            <div className={style.appHeaderTitles}>
              <span className={style.appHeaderTitle}>{research}</span>
              <span className={style.appHeaderTitleSeparator}>/</span>
              <span className={style.appHeaderTitle}>{openPage}</span>
            </div>
          </div>

          <div className={mock.doc}>
            <div className={mock.docInner}>
              <h1 className={mock.docTitle}>{openPage}</h1>
              <p className={mock.docText}>
                {t(
                  "sample.docLead",
                  "The bell curve keeps turning up because adding enough independent things together produces it, whatever those things started out as.",
                )}
              </p>

              {/* Wordless by design: the same figure in every locale. */}
              <div className={mock.math}>
                <span className={mock.integral}>
                  <span className={mock.integralGlyph}>∫</span>
                  <span className={mock.limits}>
                    <span>∞</span>
                    <span>0</span>
                  </span>
                </span>
                <span className={mock.var}>e</span>
                <span className={mock.sup}>
                  −<span className={mock.var}>x</span>
                  <span className={mock.sup}>2</span>
                </span>
                <span className={mock.dx}>
                  d<span className={mock.var}>x</span>
                </span>
                <span className={mock.rel}>=</span>
                <span className={mock.frac}>
                  <span className={mock.fracNum}>
                    √<span className={mock.radicand}>π</span>
                  </span>
                  <span className={mock.fracDen}>2</span>
                </span>
              </div>

              <p className={mock.docText}>
                {t(
                  "sample.docAfterMath",
                  "Which fixes the constant out in front: the curve has to enclose exactly one unit of area, or it is not describing a probability at all.",
                )}
              </p>
              <ul className={mock.docList}>
                <li>
                  {t(
                    "sample.docTodoVariance",
                    "Does the same argument survive without finite variance?",
                  )}
                </li>
                <li>
                  {t(
                    "sample.docTodoPlot",
                    "Plot how fast a lopsided die converges.",
                  )}
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
