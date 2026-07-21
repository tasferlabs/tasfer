import { Skeleton } from "tasfer";

const stack: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

export function Text() {
  return (
    <div style={{ ...stack, width: 280 }}>
      <Skeleton style={{ height: 12, width: "80%" }} />
      <Skeleton style={{ height: 12, width: "100%" }} />
      <Skeleton style={{ height: 12, width: "60%" }} />
    </div>
  );
}

export function Avatar() {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <Skeleton style={{ height: 40, width: 40, borderRadius: "9999px" }} />
      <div style={{ ...stack, width: 180 }}>
        <Skeleton style={{ height: 12, width: "70%" }} />
        <Skeleton style={{ height: 12, width: "45%" }} />
      </div>
    </div>
  );
}

export function Card() {
  return (
    <div style={{ ...stack, width: 260 }}>
      <Skeleton style={{ height: 120, width: "100%" }} />
      <Skeleton style={{ height: 14, width: "75%" }} />
      <Skeleton style={{ height: 12, width: "90%" }} />
    </div>
  );
}
