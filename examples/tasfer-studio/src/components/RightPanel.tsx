import type { OutlineItem } from "../util";

interface RightPanelProps {
  /** Live heading outline derived from the editor's Markdown. */
  outline: OutlineItem[];
}

const PEERS = [
  { initial: "A", name: "you", color: "#39c5cf", text: "#04181a", online: true },
  { initial: "M", name: "maya", color: "#7c6cf0", text: "#fff", online: true },
  { initial: "J", name: "jonas", color: "#3a4452", text: "#c4ccd6", online: false },
];

export function RightPanel({ outline }: RightPanelProps) {
  return (
    <aside className="right">
      <div className="right__heading">Outline</div>
      <div className="right__outline">
        {outline.length === 0 ? (
          <div className="right__outline-empty">No headings yet</div>
        ) : (
          outline.map((item, i) => (
            <div
              key={`${item.text}-${i}`}
              className={
                "right__outline-item" +
                ` right__outline-item--l${item.level}` +
                (i === 0 ? " right__outline-item--active" : "")
              }
            >
              {item.text}
            </div>
          ))
        )}
      </div>

      <div className="right__heading">Live peers</div>
      <div className="right__peers">
        {PEERS.map((p) => (
          <div key={p.name} className={"right__peer" + (p.online ? "" : " right__peer--off")}>
            <span className="right__avatar" style={{ background: p.color, color: p.text }}>
              {p.initial}
            </span>
            <span className="right__peer-name">{p.name}</span>
            <span className={"right__peer-dot" + (p.online ? "" : " right__peer-dot--off")} />
          </div>
        ))}
      </div>
    </aside>
  );
}
