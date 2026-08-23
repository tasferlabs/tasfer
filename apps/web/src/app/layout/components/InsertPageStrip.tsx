import { useDndContext } from "@dnd-kit/core";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import Icons from "../../components/uiKit/Icons/Icons";
import style from "./PagesLinks.module.css";

/**
 * A hairline on the seam between two page rows that fades in on hover and
 * inserts a page there when clicked.
 *
 * Pointer-only by design: it stays out of the tab order and is not rendered for
 * coarse pointers, because the same two actions live in the page menu, which
 * reaches keyboard, touch and screen-reader users. It also unmounts for the
 * duration of a drag, so it never competes with the drop zones that own the
 * same band.
 *
 * A plain button rather than the shared one: that base clips its overflow and
 * runs a press ripple, neither of which suits a 1px line with a badge hanging
 * outside it.
 */
export function InsertPageStrip({
  position,
  onInsert,
  disabled = false,
}: {
  position: "before" | "after";
  onInsert: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { active } = useDndContext();

  if (active) return null;

  const label =
    position === "before"
      ? t("page.addPageAbove", "Add page above")
      : t("page.addPageBelow", "Add page below");

  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      title={label}
      className={clsx(
        style.insertStrip,
        position === "before" ? style.insertStripBefore : style.insertStripAfter,
      )}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        if (disabled) return;
        onInsert();
      }}
    >
      <span className={style.insertStripPlus}>
        <Icons.Plus width={11} height={11} />
      </span>
      <span className={style.insertStripLine} />
    </button>
  );
}
