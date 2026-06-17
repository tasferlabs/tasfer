/**
 * TeX font-dimension constants (the "sigma" and "xi" parameters) and the
 * inter-atom spacing table. Values are the standard Computer-Modern font
 * dimensions, as used by TeX and KaTeX (MIT); see KATEX_LICENSE. Each tuple is
 * `[textstyle, scriptstyle, scriptscriptstyle]` in em units.
 */

/** The three size columns the sigma/xi tuples are indexed by. */
export type SizeColumn = 0 | 1 | 2;

type Triple = readonly [number, number, number];

const SIGMA: Record<string, Triple> = {
  slant: [0.25, 0.25, 0.25],
  space: [0.0, 0.0, 0.0],
  stretch: [0.0, 0.0, 0.0],
  shrink: [0.0, 0.0, 0.0],
  xHeight: [0.431, 0.431, 0.431],
  quad: [1.0, 1.171, 1.472],
  extraSpace: [0.0, 0.0, 0.0],
  num1: [0.677, 0.732, 0.925],
  num2: [0.394, 0.384, 0.387],
  num3: [0.444, 0.471, 0.504],
  denom1: [0.686, 0.752, 1.025],
  denom2: [0.345, 0.344, 0.532],
  sup1: [0.413, 0.503, 0.504],
  sup2: [0.363, 0.431, 0.404],
  sup3: [0.289, 0.286, 0.294],
  sub1: [0.15, 0.143, 0.2],
  sub2: [0.247, 0.286, 0.4],
  supDrop: [0.386, 0.353, 0.494],
  subDrop: [0.05, 0.071, 0.1],
  delim1: [2.39, 1.7, 1.98],
  delim2: [1.01, 1.157, 1.42],
  axisHeight: [0.25, 0.25, 0.25],
  defaultRuleThickness: [0.04, 0.049, 0.049],
  bigOpSpacing1: [0.111, 0.111, 0.111],
  bigOpSpacing2: [0.166, 0.166, 0.166],
  bigOpSpacing3: [0.2, 0.2, 0.2],
  bigOpSpacing4: [0.6, 0.611, 0.611],
  bigOpSpacing5: [0.1, 0.143, 0.143],
  sqrtRuleThickness: [0.04, 0.04, 0.04],
  ptPerEm: [10.0, 10.0, 10.0],
};

export type SigmaName = keyof typeof SIGMA;

/** A resolved set of font metrics for one size column. */
export type FontMetrics = Record<SigmaName, number> & { cssEmPerMu: number };

const byColumn: (FontMetrics | undefined)[] = [];

/** Font dimensions resolved for a given size column (memoized). */
export function getFontMetrics(column: SizeColumn): FontMetrics {
  const cached = byColumn[column];
  if (cached) return cached;
  const m = { cssEmPerMu: SIGMA.quad[column] / 18 } as FontMetrics;
  for (const key of Object.keys(SIGMA)) {
    m[key] = SIGMA[key][column];
  }
  byColumn[column] = m;
  return m;
}

/** Per-size font-size multipliers (index = TeX size 1..11, minus one). */
export const SIZE_MULTIPLIERS = [
  0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.44, 1.728, 2.074, 2.488,
] as const;

/**
 * `[textsize, scriptsize, scriptscriptsize]` size index for each base size.
 * Index = base TeX size 1..11, minus one. (\normalsize = 6 → [6, 3, 1].)
 */
export const SIZE_STYLE_MAP: ReadonlyArray<Triple> = [
  [1, 1, 1],
  [2, 1, 1],
  [3, 1, 1],
  [4, 2, 1],
  [5, 2, 1],
  [6, 3, 1],
  [7, 4, 2],
  [8, 6, 3],
  [9, 7, 6],
  [10, 8, 7],
  [11, 10, 9],
];

/** Map a resolved TeX size (1..11) to its sigma/xi column. */
export function sizeColumn(size: number): SizeColumn {
  if (size >= 5) return 0;
  if (size >= 3) return 1;
  return 2;
}

/**
 * Inter-atom spacing, in mu (math units; 18mu = 1em at the current size).
 * Outer key = left atom class, inner key = right atom class. Mirrors TeX's
 * spacing matrix for display/text styles.
 */
const THIN = 3;
const MED = 4;
const THICK = 5;

export type AtomClass =
  | "mord"
  | "mop"
  | "mbin"
  | "mrel"
  | "mopen"
  | "mclose"
  | "mpunct"
  | "minner";

export const SPACINGS: Partial<
  Record<AtomClass, Partial<Record<AtomClass, number>>>
> = {
  mord: { mop: THIN, mbin: MED, mrel: THICK, minner: THIN },
  mop: { mord: THIN, mop: THIN, mrel: THICK, minner: THIN },
  mbin: { mord: MED, mop: MED, mopen: MED, minner: MED },
  mrel: { mord: THICK, mop: THICK, mopen: THICK, minner: THICK },
  mopen: {},
  mclose: { mop: THIN, mbin: MED, mrel: THICK, minner: THIN },
  mpunct: {
    mord: THIN,
    mop: THIN,
    mrel: THICK,
    mopen: THIN,
    mclose: THIN,
    mpunct: THIN,
    minner: THIN,
  },
  minner: {
    mord: THIN,
    mop: THIN,
    mbin: MED,
    mrel: THICK,
    mopen: THIN,
    mpunct: THIN,
    minner: THIN,
  },
};

/** Tight (script/scriptscript) spacing — most inter-atom glue vanishes. */
export const TIGHT_SPACINGS: Partial<
  Record<AtomClass, Partial<Record<AtomClass, number>>>
> = {
  mord: { mop: THIN },
  mop: { mord: THIN, mop: THIN },
  mbin: {},
  mrel: {},
  mopen: {},
  mclose: { mop: THIN },
  mpunct: {},
  minner: { mop: THIN },
};
