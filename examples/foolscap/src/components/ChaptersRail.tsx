interface ChaptersRailProps {
  /** Live word count of the open chapter (drives the goal progress). */
  words: number;
  /** Today's writing goal, in words. */
  goal: number;
}

const CHAPTERS = [
  { label: "I · The Tide", count: "3,210", active: false, muted: false, draft: false },
  { label: "II · Saltwater", count: "live", active: true, muted: false, draft: false },
  { label: "III · Undertow", count: "—", active: false, muted: false, draft: false },
  { label: "IV · untitled", count: "—", active: false, muted: true, draft: true },
];

export function ChaptersRail({ words, goal }: ChaptersRailProps) {
  const pct = Math.min(100, Math.round((words / goal) * 100));

  return (
    <aside className="rail">
      <div className="rail__brand">
        <span className="rail__mark">◆</span>
        <span className="rail__wordmark">Foolscap</span>
      </div>

      <div className="rail__eyebrow">Manuscript</div>
      <div className="rail__title">Saltwater</div>

      <nav className="rail__chapters">
        {CHAPTERS.map((c) => (
          <div
            key={c.label}
            className={
              "rail__chapter" +
              (c.active ? " rail__chapter--active" : "") +
              (c.muted ? " rail__chapter--muted" : "")
            }
          >
            <span className={c.draft ? "rail__chapter-name rail__chapter-name--draft" : "rail__chapter-name"}>
              {c.label}
            </span>
            <span className="rail__chapter-count">{c.active ? words.toLocaleString() : c.count}</span>
          </div>
        ))}
      </nav>

      <div className="rail__goal">
        <div className="rail__goal-label">Today's goal</div>
        <div className="rail__goal-track">
          <div className="rail__goal-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="rail__goal-caption">
          {words.toLocaleString()} of {goal.toLocaleString()} words
        </div>
      </div>
    </aside>
  );
}
