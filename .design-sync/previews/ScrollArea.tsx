import { ScrollArea } from "tasfer";

const frame: React.CSSProperties = {
  height: 180,
  width: 280,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
};

const rowStyle: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: 14,
  borderBottom: "1px solid var(--border)",
};

const layers = [
  "Cover frame",
  "Hero heading",
  "Roadmap grid",
  "Q3 milestones",
  "Connector arrows",
  "Sticky notes",
  "Team avatars",
  "Legend",
  "Footer note",
  "Background grid",
];

export function Layers() {
  return (
    <ScrollArea style={frame}>
      <div style={{ padding: 4 }}>
        <div
          style={{
            padding: "8px 12px",
            fontSize: 12,
            fontWeight: 600,
            color: "var(--muted-foreground)",
          }}
        >
          Layers
        </div>
        {layers.map((name) => (
          <div key={name} style={rowStyle}>
            {name}
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

export function Activity() {
  const events = [
    "Alex moved Hero heading",
    "Sam joined the canvas",
    "Alex added a sticky note",
    "Jordan edited Q3 milestones",
    "Sam locked the Roadmap grid",
    "Alex exported cover.png",
    "Jordan connected two frames",
    "Sam left a comment",
    "Alex renamed the document",
  ];
  return (
    <ScrollArea style={frame}>
      <div style={{ padding: 4 }}>
        {events.map((event, i) => (
          <div key={i} style={rowStyle}>
            <span style={{ color: "var(--muted-foreground)" }}>
              {String(9 - i).padStart(2, "0")}:{i % 2 ? "14" : "42"}
            </span>{" "}
            {event}
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
