# Tasfer — brand & design guidance

Tasfer is a local-first, peer-to-peer, canvas-based editor. It runs on the
user's device, syncs directly between peers, and answers to no server.

Use the tokens below by **name** (`var(--primary)`, `text-muted-foreground`,
`rounded-[--radius]`) rather than hard-coding hex — every value is already
shipped in `_ds_bundle.css` and themes automatically between light and dark.

---

## The mark

The Tasfer mark is **صفر** ("sifr" — zero) drawn as a single calligraphic
stroke. It is a vector; reproduce it from the path below, never re-trace it
by eye.

<svg viewBox="0 0 100 140" width="48" height="67" fill="none" role="img" aria-label="Tasfer">
  <path d="M 57 4 Q 79 34 83 66 Q 58 98 41 136 Q 30 98 17 64 Q 39 32 57 4 Z" fill="var(--primary)" />
</svg>

```svg
<svg viewBox="0 0 100 140" fill="none" role="img" aria-label="Tasfer">
  <path d="M 57 4 Q 79 34 83 66 Q 58 98 41 136 Q 30 98 17 64 Q 39 32 57 4 Z"
        fill="var(--primary)" />
</svg>
```

**Usage**

- Fill is the brand green (`var(--primary)` → `#43a047` light, `#66bb6a` dark).
  The mark carries the color; never outline or add a second color.
- It scales like `object-fit: contain` (default `xMidYMid meet`) — drop it into
  any square or portrait box and it centers itself.
- Keep clear-space around it of at least the width of the stroke's waist.
- Minimum height ~16px; below that the stroke thins out.
- Don't: rotate, skew, add gradients/shadows, place on a low-contrast surface,
  or recolor it to anything but the brand green (or a solid ink/paper for
  single-color contexts).

## Wordmark

"**tasfer**" — always lowercase, set in the base sans (**Poppins**), weight
**600**, letter-spacing **-0.03em**, in ink (`var(--foreground)`). When the mark
sits beside the wordmark, the mark carries the green and the word stays ink.

---

## Color

Semantic tokens (values shown light → dark). Reference the token; both themes
resolve automatically.

| Token                  | Role                                           | Light                                | Dark                                 |
| ---------------------- | ---------------------------------------------- | ------------------------------------ | ------------------------------------ |
| `--primary`            | Brand green — primary actions, focus, the mark | `oklch(0.629 0.154 145)` ≈ `#43a047` | `oklch(0.718 0.142 145)` ≈ `#66bb6a` |
| `--primary-foreground` | Text/icon on primary                           | `oklch(0.98 0.02 145)`               | `oklch(0.26 0.05 173)`               |
| `--background`         | Page surface                                   | `#ffffff`                            | `#09090b`                            |
| `--foreground`         | Body text                                      | `#09090b`                            | `oklch(0.985 0 0)` ≈ `#fafafa`       |
| `--card` / `--popover` | Raised surfaces                                | `#ffffff`                            | `oklch(0.21 0.006 285.9)`            |
| `--muted`              | Subtle fills                                   | `oklch(0.967 0.001 286.4)`           | `oklch(0.274 0.006 286)`             |
| `--muted-foreground`   | Secondary text                                 | `oklch(0.552 0.016 285.9)`           | `oklch(0.705 0.015 286)`             |
| `--accent`             | Hover / low-emphasis fills                     | `oklch(0.967 0.001 286.4)`           | `oklch(0.274 0.006 286)`             |
| `--secondary`          | Secondary buttons/chips                        | `oklch(0.967 0.001 286.4)`           | `oklch(0.274 0.006 286)`             |
| `--border` / `--input` | Hairlines, field edges                         | `oklch(0.92 0.004 286.3)`            | `oklch(1 0 0 / 10%)`                 |
| `--ring`               | Focus ring                                     | `oklch(0.6332 0.1426 163 / 60%)`     | same                                 |
| `--destructive`        | Errors, destructive actions                    | `oklch(0.577 0.245 27.3)`            | `oklch(0.704 0.191 22.2)`            |

**Notes**

- The green is the _only_ brand hue. Everything else is a near-neutral gray
  (a whisper of violet, hue ~286) so the green always reads as the accent.
- **Default page/accent color is neutral gray, not green.** A page with no
  explicit color uses `--page-color-default` (→ `--muted-foreground`), matching
  the page's color dot. Don't reach for green as a generic accent — it's
  reserved for genuine primary actions, focus, and the mark.
- Charts use a green monochrome ramp (`--chart-1`…`--chart-5`).

## Typography

| Family                | Role                                              | Token                 |
| --------------------- | ------------------------------------------------- | --------------------- |
| **Poppins**           | Body / UI (the product body face)                 | `--font-sans`         |
| **Space Grotesk**     | Display — large headlines, monograms (Latin-only) | `--font-display`      |
| **Libre Baskerville** | Serif accents                                     | `--font-serif`        |
| system mono           | Code                                              | `--font-mono`         |
| **Noto Sans Arabic**  | Arabic backing for sans & display                 | (in the stacks above) |

Poppins and Space Grotesk carry Latin; Noto Sans Arabic backs both for RTL/Arabic
text. Only latin + arabic subsets ship — other scripts fall back.

## Shape

- Corner radius: `--radius` = **0.45rem** (~7px). Cards, buttons, inputs, and
  popovers derive their rounding from it — don't introduce ad-hoc radii.
🤖