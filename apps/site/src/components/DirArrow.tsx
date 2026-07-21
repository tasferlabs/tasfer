/**
 * Inline back/forward arrow that mirrors under `dir="rtl"`.
 *
 * Baking "←"/"→" into a translated string looks like it works: both are
 * Bidi_Mirrored, so a conformant shaper flips them in an RTL run and the
 * browser happens to render the right thing. But the direction then lives in
 * the shaper rather than in the markup — it is invisible at the call site, and
 * it silently reverses anywhere the bidi algorithm isn't applied the same way
 * (canvas, PDF export, screenshot pipelines). Drawing the arrow as geometry and
 * mirroring it with an explicit `[dir="rtl"]` transform (see `.dir-arrow` in
 * styles/globals.css) keeps the direction where it can be seen and tested.
 *
 * `towards` is logical, not physical: "back" points at the start of the inline
 * axis (left in LTR, right in RTL), "forward" at the end.
 */
export function DirArrow({ towards }: { towards: "back" | "forward" }) {
  return (
    <svg
      className="dir-arrow"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {towards === "back" ? (
        <path d="M19 12H5M11 19l-7-7 7-7" />
      ) : (
        <path d="M5 12h14M13 5l7 7-7 7" />
      )}
    </svg>
  );
}

export default DirArrow;
