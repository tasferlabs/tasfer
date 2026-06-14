/**
 * Type declarations for the prebuilt MathJax bundle (`mathjax-bundle.mjs`).
 *
 * The bundle is a generated artifact with no shipped types. We declare only the
 * surface consumed by `math.ts`. Node shapes are intentionally opaque — the
 * editor only forwards them between MathJax APIs and reads serialized output.
 */

/** Opaque MathJax DOM node produced by `MathDocument.convert`. */
export type MathNode = unknown;

export interface MathDocument {
  convert(latex: string, options: { display: boolean }): MathNode;
  clear(): void;
}

export interface MathJax {
  document(
    input: string,
    options: { InputJax: unknown; OutputJax: unknown },
  ): MathDocument;
}

export interface LiteAdaptor {
  outerHTML(node: MathNode): string;
}

export interface TeXConstructor {
  new (options: { packages: string[] }): unknown;
}

export interface SVGConstructor {
  new (options: { fontCache: string }): unknown;
}

export interface MathJaxBundle {
  mathjax: MathJax;
  TeX: TeXConstructor;
  SVG: SVGConstructor;
  liteAdaptor: () => LiteAdaptor;
  RegisterHTMLHandler: (adaptor: LiteAdaptor) => void;
  AllPackages: string[];
}

declare const bundle: MathJaxBundle;
export default bundle;
