# Tasfer UI — how to build with this library

A shadcn-style React kit (Radix primitives + Tailwind v4) for **Tasfer**, a
local-first, peer-to-peer, canvas document editor. Import every component and
sub-part from the bundle global: `window.TasferUI.<Name>`.

## Setup

- **No global provider is required** — components are styled entirely by the
  shipped `styles.css` (Tailwind v4 utilities + CSS-variable design tokens).
  Make sure `styles.css` is loaded.
- **Tooltip is the one exception**: wrap tooltips (or the app root) in
  `<TooltipProvider>`.
- **Dark mode**: add `class="dark"` to any ancestor. All tokens have light/dark
  values; everything below re-themes automatically.

## Styling idiom — Tailwind utilities backed by design tokens

Style your own layout/glue with Tailwind utility classes that resolve to the
theme tokens (never hardcode hex — use the token so light/dark and brand stay
consistent). The load-bearing families:

| Purpose | Utilities |
|---|---|
| Surfaces | `bg-background` `bg-card` `bg-muted` `bg-secondary` `bg-accent` `bg-popover` |
| Brand / status | `bg-primary` `text-primary` `bg-destructive/10 text-destructive` |
| Text | `text-foreground` `text-muted-foreground` `text-primary-foreground` |
| Borders / focus | `border` `border-border` `ring-1 ring-foreground/10` |
| Radius | `rounded-md` `rounded-lg` `rounded-xl` (scale from `--radius`) |

The shipped `styles.css` carries the standard Tailwind utilities the components
use (all common spacing/flex/grid/text/color/rounded/shadow classes are present).
For **arbitrary values** (`w-[360px]`, one-off sizes) use an inline `style`
instead — the stylesheet is prebuilt and won't contain unseen arbitrary classes.

The same tokens exist as raw CSS variables for inline styles or custom CSS:
`var(--primary)`, `var(--background)`, `var(--card)`, `var(--foreground)`,
`var(--muted-foreground)`, `var(--border)`, `var(--destructive)`, `var(--accent)`,
`var(--radius)`. Body font is `var(--font-sans)` (Poppins). **Read `styles.css`**
for the full token set before styling.

## Component variants & sub-part props

Root props are in each component's `.d.ts`. A few design-defining props live on
sub-parts (not the root), so note:

- **Button** / **Badge**: `variant` (`default`/`outline`/`secondary`/`ghost`/`destructive`/`link`) + Button `size` (`default`/`sm`/`lg`/`icon`/`icon-sm`…).
- **Tabs**: `variant` is on **`TabsList`** — `"default"` (pill) or `"line"` (underline). `orientation` is on `Tabs`.
- **Select**: `size` (`sm`/`default`) is on **`SelectTrigger`**.
- **Sheet**: `side` (`top`/`right`/`bottom`/`left`) is on **`SheetContent`**.
- **Field** / **ButtonGroup**: `orientation` (`vertical`/`horizontal`).
- **Alert**: `variant` `default`/`destructive`.

## Composition patterns (compound components)

```jsx
const { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle,
        DialogDescription, DialogFooter, DialogClose, Button, Input, Label,
        Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter,
        Tabs, TabsList, TabsTrigger, TabsContent } = window.TasferUI;

// Dialog (also the shape for AlertDialog / Sheet / Drawer / Popover / DropdownMenu):
<Dialog>
  <DialogTrigger asChild><Button variant="outline">Rename</Button></DialogTrigger>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Rename page</DialogTitle>
      <DialogDescription>Updates for everyone with access.</DialogDescription>
    </DialogHeader>
    <div style={{ display: "grid", gap: 6 }}>
      <Label htmlFor="n">Name</Label>
      <Input id="n" defaultValue="Product roadmap" />
    </div>
    <DialogFooter>
      <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
      <Button>Save</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>

// Card + Tabs:
<Card style={{ width: 360 }}>
  <CardHeader><CardTitle>Workspace</CardTitle>
    <CardDescription>Peer-to-peer sync settings.</CardDescription></CardHeader>
  <CardContent>
    <Tabs defaultValue="general">
      <TabsList><TabsTrigger value="general">General</TabsTrigger>
        <TabsTrigger value="sharing">Sharing</TabsTrigger></TabsList>
      <TabsContent value="general" className="text-muted-foreground text-sm">…</TabsContent>
    </Tabs>
  </CardContent>
</Card>
```

Overlays (`Dialog`, `AlertDialog`, `Sheet`, `Drawer`, `Popover`,
`DropdownMenu`, `Tooltip`) are controlled with `open`/`defaultOpen`/`onOpenChange`
(radix) — **`BottomSheet` is `open` + `onOpenChange` only** (required). Per
component, read its `.prompt.md` and `.d.ts`.
