import parsePage from "./parser";
import tokenizePage from "./tokenizer";

export interface Heading {
  type: "heading";
  level: number;
  content: Text[];
}
export interface Paragraph {
  type: "paragraph";
  content: Text[];
}

export interface Text {
  content: string;
  format?: string;
}

export type Block = Heading | Paragraph;

export interface Page {
  title: String;
  // color: string;
  // icon: string;
  blocks: Block[];
}

export function loadPage(content: string): Page {
  const tokens = tokenizePage(content);
  const page = parsePage(tokens);
  return page;
}
