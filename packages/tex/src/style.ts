/**
 * The TeX math styles (display / text / script / scriptscript, each with a
 * cramped variant) and the transitions between them. Ported from KaTeX's
 * Style.ts (MIT). Each style is precomputed for a base text size of
 * \normalsize (TeX size 6), which fixes its size multiplier and sigma column —
 * the engine does not yet support \large etc.
 */
import {
  type FontMetrics,
  getFontMetrics,
  SIZE_MULTIPLIERS,
  SIZE_STYLE_MAP,
  sizeColumn,
  type SizeColumn,
} from "./data/constants.ts";

// Style ids.
const D = 0;
const Dc = 1;
const T = 2;
const Tc = 3;
const S = 4;
const Sc = 5;
const SS = 6;
const SSc = 7;

// Transition tables (indexed by style id).
const SUP = [S, Sc, S, Sc, SS, SSc, SS, SSc];
const SUB = [Sc, Sc, Sc, Sc, SSc, SSc, SSc, SSc];
const FRAC_NUM = [T, Tc, S, Sc, SS, SSc, SS, SSc];
const FRAC_DEN = [Tc, Tc, Sc, Sc, SSc, SSc, SSc, SSc];
const CRAMP = [Dc, Dc, Tc, Tc, Sc, Sc, SSc, SSc];

const BASE_TEX_SIZE = 6;

export class Style {
  readonly id: number;
  /** 0 = display/text, 1 = script, 2 = scriptscript (drives sigma column & glue). */
  readonly styleSize: number;
  readonly cramped: boolean;
  /** Resolved TeX font size 1..11 at the base text size. */
  readonly texSize: number;
  /** Font-size multiplier relative to the base (1.0 / 0.7 / 0.5). */
  readonly sizeMultiplier: number;
  private readonly column: SizeColumn;

  constructor(id: number, styleSize: number, cramped: boolean) {
    this.id = id;
    this.styleSize = styleSize;
    this.cramped = cramped;
    this.texSize =
      styleSize < 2
        ? BASE_TEX_SIZE
        : SIZE_STYLE_MAP[BASE_TEX_SIZE - 1][styleSize - 1];
    this.sizeMultiplier = SIZE_MULTIPLIERS[this.texSize - 1];
    this.column = sizeColumn(this.texSize);
  }

  /** Sigma/xi font metrics resolved for this style's size column. */
  metrics(): FontMetrics {
    return getFontMetrics(this.column);
  }

  sup(): Style {
    return STYLES[SUP[this.id]];
  }
  sub(): Style {
    return STYLES[SUB[this.id]];
  }
  fracNum(): Style {
    return STYLES[FRAC_NUM[this.id]];
  }
  fracDen(): Style {
    return STYLES[FRAC_DEN[this.id]];
  }
  cramp(): Style {
    return STYLES[CRAMP[this.id]];
  }

  /** Script/scriptscript styles are "tight" (reduced inter-atom glue). */
  isTight(): boolean {
    return this.styleSize >= 2;
  }
}

const STYLES: Style[] = [
  new Style(D, 0, false),
  new Style(Dc, 0, true),
  new Style(T, 1, false),
  new Style(Tc, 1, true),
  new Style(S, 2, false),
  new Style(Sc, 2, true),
  new Style(SS, 3, false),
  new Style(SSc, 3, true),
];

export const DISPLAY = STYLES[D];
export const TEXT = STYLES[T];
export const SCRIPT = STYLES[S];
export const SCRIPTSCRIPT = STYLES[SS];
