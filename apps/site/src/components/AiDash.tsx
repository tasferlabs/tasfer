"use client";

import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Link } from "./Link";
import "./AiDash.css";

/** Internal note the tooltip links to. */
const STANCE_PATH = "/docs/internals/ai-stance";
/** Keeps the bubble this far from the viewport edges. */
const EDGE_GAP = 8;
/** Grace period for the pointer to travel from the dash into the bubble. */
const CLOSE_DELAY_MS = 150;

/**
 * An em dash that admits it. Hovering (or tapping) it opens a small bubble
 * saying the site's writing uses AI, with a link to the note on our stance.
 *
 * The bubble is only mounted while open, so the dash reads as a plain "—" to
 * crawlers, screen readers, and anything that takes `textContent` (the docs
 * table of contents). The dash is not a tab stop: there are hundreds of them
 * per page.
 */
export function AiDash() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const lastPointer = useRef<string>("mouse");

  const cancelClose = () => window.clearTimeout(closeTimer.current);
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };

  useEffect(() => cancelClose, []);

  // A tap opens it; a tap anywhere else, or Escape, closes it.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Centered over the dash, then nudged back inside the viewport so a dash
  // near the edge never pushes the page sideways on a phone.
  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    if (!open || !bubble) return;
    bubble.style.setProperty("--ai-dash-shift", "0px");
    const rect = bubble.getBoundingClientRect();
    const viewport = document.documentElement.clientWidth;
    let shift = 0;
    if (rect.left < EDGE_GAP) shift = EDGE_GAP - rect.left;
    else if (rect.right > viewport - EDGE_GAP) {
      shift = viewport - EDGE_GAP - rect.right;
    }
    bubble.style.setProperty("--ai-dash-shift", `${shift}px`);
  }, [open]);

  return (
    <span
      ref={rootRef}
      className="ai-dash"
      data-open={open || undefined}
      onPointerDown={(e) => {
        lastPointer.current = e.pointerType;
      }}
      onPointerEnter={(e) => {
        if (e.pointerType !== "mouse") return;
        cancelClose();
        setOpen(true);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") scheduleClose();
      }}
      onClick={() => {
        // A mouse already opened it on hover; a click must not shut it.
        if (lastPointer.current === "mouse") setOpen(true);
        else setOpen((o) => !o);
      }}
    >
      —
      {open ? (
        <span ref={bubbleRef} className="ai-dash-bubble" role="tooltip">
          <span className="ai-dash-card">
            <span className="ai-dash-note">
              {t("aiDash.note", "Yes, we use AI here.")}
            </span>
            <Link className="ai-dash-link" to={STANCE_PATH}>
              {t("aiDash.stance", "Read our stance on it")}
            </Link>
          </span>
        </span>
      ) : null}
    </span>
  );
}

/**
 * Swaps every "—" in a string for an {@link AiDash}. Anything that is not a
 * string (already-built nodes, numbers, null) passes through untouched.
 */
export function withAiDash(node: ReactNode): ReactNode {
  if (typeof node !== "string" || !node.includes("—")) return node;
  const parts = node.split("—");
  return parts.map((part, i) => (
    <Fragment key={i}>
      {i > 0 ? <AiDash /> : null}
      {part}
    </Fragment>
  ));
}

export default AiDash;
