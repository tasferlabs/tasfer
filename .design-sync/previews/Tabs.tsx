import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "tasfer";

const panel: React.CSSProperties = {
  paddingTop: 12,
  color: "var(--muted-foreground)",
  lineHeight: 1.5,
};

export function Default() {
  return (
    <Tabs defaultValue="canvas" style={{ width: 380 }}>
      <TabsList>
        <TabsTrigger value="canvas">Canvas</TabsTrigger>
        <TabsTrigger value="layers">Layers</TabsTrigger>
        <TabsTrigger value="history">History</TabsTrigger>
      </TabsList>
      <TabsContent value="canvas" style={panel}>
        The infinite canvas where you draw, arrange, and connect ideas.
      </TabsContent>
      <TabsContent value="layers" style={panel}>
        Reorder, lock, and hide the objects on the current frame.
      </TabsContent>
      <TabsContent value="history" style={panel}>
        Browse every change and restore an earlier version of the document.
      </TabsContent>
    </Tabs>
  );
}

export function Line() {
  return (
    <Tabs defaultValue="share" style={{ width: 380 }}>
      <TabsList variant="line">
        <TabsTrigger value="share">Share</TabsTrigger>
        <TabsTrigger value="peers">Peers</TabsTrigger>
        <TabsTrigger value="access">Access</TabsTrigger>
      </TabsList>
      <TabsContent value="share" style={panel}>
        Copy a link to invite others directly to this canvas.
      </TabsContent>
      <TabsContent value="peers" style={panel}>
        3 peers are connected and syncing in real time.
      </TabsContent>
      <TabsContent value="access" style={panel}>
        Choose whether new peers can edit or only view.
      </TabsContent>
    </Tabs>
  );
}

export function Vertical() {
  return (
    <Tabs orientation="vertical" defaultValue="grid" style={{ width: 380 }}>
      <TabsList>
        <TabsTrigger value="grid">Grid</TabsTrigger>
        <TabsTrigger value="snapping">Snapping</TabsTrigger>
        <TabsTrigger value="theme">Theme</TabsTrigger>
      </TabsList>
      <TabsContent value="grid" style={{ ...panel, paddingTop: 0, paddingInlineStart: 12 }}>
        Show a background grid and set its spacing.
      </TabsContent>
      <TabsContent value="snapping" style={{ ...panel, paddingTop: 0, paddingInlineStart: 12 }}>
        Snap objects to the grid and to nearby edges.
      </TabsContent>
      <TabsContent value="theme" style={{ ...panel, paddingTop: 0, paddingInlineStart: 12 }}>
        Switch the canvas between light and dark.
      </TabsContent>
    </Tabs>
  );
}
