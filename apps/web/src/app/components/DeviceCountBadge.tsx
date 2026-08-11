/**
 * Device count badge — a person connected from more than one device keeps a
 * single avatar, and this badge on its corner carries the count.
 *
 * It renders as a sibling of the avatar rather than inside it: avatars clip
 * their contents, and in an overlapping row there is no room to grow sideways.
 * The parent must be positioned; see `.device-count-badge` in styles.css.
 */

/** Past this the exact number stops mattering and the width starts to. */
const MAX_SHOWN = 9;

export function DeviceCountBadge({
  count,
  color,
  placement = "bottom",
}: {
  count: number;
  /** Badge fill — pass the avatar's color so the two read as one object. */
  color?: string;
  /** Corner to sit on; `top` keeps clear of a presence dot below. */
  placement?: "bottom" | "top";
}) {
  if (count < 2) return null;

  return (
    <span
      className="device-count-badge"
      data-placement={placement}
      style={color ? ({ ["--badge-color" as string]: color }) : undefined}
      aria-hidden
    >
      {count > MAX_SHOWN ? `${MAX_SHOWN}+` : count}
    </span>
  );
}
