import type { TFunction } from "i18next";

import type { IVersion } from "../api/pages.api";

/**
 * Turns a version entry into the one line a person reads when choosing where to
 * revert to.
 *
 * The engine hands over counters and a kind, never a sentence: the phrasing is
 * the host's, and it has to be translatable as a whole sentence rather than
 * assembled from clauses, which is why each shape gets its own key instead of
 * concatenating "added" + "3" + "blocks".
 */
export function versionLabel(version: IVersion, t: TFunction): string {
  const { change, kind, subject } = version;

  switch (kind) {
    case "created":
      return subject
        ? t("version.createdNamed", "Started “{{subject}}”", { subject })
        : t("version.created", "Page created");

    case "replaced":
      return t("version.replaced", "Replaced the whole page");

    case "deletion":
      return t("version.deleted", {
        count: change.blocksRemoved,
        defaultValue_one: "Deleted {{count, number}} block",
        defaultValue_other: "Deleted {{count, number}} blocks",
      });

    case "addition":
      return subject
        ? t("version.addedNamed", "Added “{{subject}}”", { subject })
        : t("version.added", {
            count: change.blocksAdded,
            defaultValue_one: "Added {{count, number}} block",
            defaultValue_other: "Added {{count, number}} blocks",
          });

    case "rewrite":
      return t("version.rewrote", {
        count: Math.max(1, change.blocksTouched),
        defaultValue_one: "Rewrote {{count, number}} block",
        defaultValue_other: "Rewrote {{count, number}} blocks",
      });

    case "formatting":
      return t("version.formatted", {
        count: Math.max(1, change.blocksTouched),
        defaultValue_one: "Restyled {{count, number}} block",
        defaultValue_other: "Restyled {{count, number}} blocks",
      });

    case "edit":
    default:
      return t("version.edited", {
        count: Math.max(1, change.blocksTouched),
        defaultValue_one: "Edited {{count, number}} block",
        defaultValue_other: "Edited {{count, number}} blocks",
      });
  }
}

/**
 * The supporting line: how much text moved, when there was any. Written as a
 * signed pair rather than a sentence so it stays scannable down a column.
 */
export function versionCharDelta(
  version: IVersion,
  t: TFunction,
): string | null {
  const { charsInserted, charsDeleted } = version.change;
  if (charsInserted === 0 && charsDeleted === 0) return null;

  // `value`, not `count`: these are signed magnitudes, not a plural subject —
  // keying them on `count` would make i18next look for plural variants of a
  // string that has no noun to agree with.
  const parts: string[] = [];
  if (charsInserted > 0) {
    parts.push(
      t("version.charsAdded", "+{{value, number}}", { value: charsInserted }),
    );
  }
  if (charsDeleted > 0) {
    parts.push(
      t("version.charsRemoved", "−{{value, number}}", { value: charsDeleted }),
    );
  }
  return parts.join(" ");
}
