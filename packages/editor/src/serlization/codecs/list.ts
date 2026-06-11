/**
 * Codec for the list family: bullet_list / numbered_list / todo_list.
 *
 * Cross-item concerns stay with the orchestrators: the markdown serializer
 * computes `ctx.listNumber` for numbered items (numbering depends on
 * neighbors), and the HTML serializer owns <ul>/<ol> group wrapping — this
 * codec's html output is the `<li>` element only.
 */

import type {
  BulletListItem,
  ListBlock,
  NumberedListItem,
  TodoListItem,
} from "../../rendering/nodes/ListNode";
import type { Block } from "../loadPage";
import {
  BULLET_LIST,
  NUMBERED_LIST,
  TODO_LIST_CHECKED,
  TODO_LIST_UNCHECKED,
} from "../tokenizer";
import type { BlockCodec, InputCtx, OutputCtx } from "./types";

export const listCodec: BlockCodec = {
  types: ["bullet_list", "numbered_list", "todo_list"],

  markdown: {
    tokens: [
      BULLET_LIST,
      NUMBERED_LIST,
      TODO_LIST_UNCHECKED,
      TODO_LIST_CHECKED,
    ],

    output(block: Block, ctx: OutputCtx): string {
      const b = block as ListBlock;
      const indent = " ".repeat(b.indent * 2);
      const content = ctx.inline(b.charRuns, b.formats);

      if (b.type === "bullet_list") {
        return `${indent}- ${content}`;
      }
      if (b.type === "numbered_list") {
        return `${indent}${ctx.listNumber ?? 1}. ${content}`;
      }
      // todo_list
      const checkbox = (b as TodoListItem).checked ? "[x]" : "[ ]";
      return `${indent}- ${checkbox} ${content}`;
    },

    input(ctx: InputCtx): Block {
      if (ctx.match(BULLET_LIST)) {
        const { charRuns, formats } = ctx.inlineText();
        const item: BulletListItem = {
          id: ctx.nextBlockId(),
          type: "bullet_list",
          charRuns,
          formats,
          indent: ctx.indent,
        };
        return item;
      }

      if (ctx.match(NUMBERED_LIST)) {
        const { charRuns, formats } = ctx.inlineText();
        const item: NumberedListItem = {
          id: ctx.nextBlockId(),
          type: "numbered_list",
          charRuns,
          formats,
          indent: ctx.indent,
        };
        return item;
      }

      const checked = ctx.check(TODO_LIST_CHECKED);
      ctx.match(TODO_LIST_CHECKED, TODO_LIST_UNCHECKED);
      const { charRuns, formats } = ctx.inlineText();
      const item: TodoListItem = {
        id: ctx.nextBlockId(),
        type: "todo_list",
        charRuns,
        formats,
        checked,
        indent: ctx.indent,
      };
      return item;
    },
  },

  html: {
    /** The <li> element only — group wrapping (<ul>/<ol>) is the orchestrator's. */
    output(block: Block, ctx: OutputCtx): string {
      const b = block as ListBlock;
      const inner = ctx.inline(b.charRuns, b.formats);
      if (b.type === "todo_list") {
        const checked = (b as TodoListItem).checked ? " checked" : "";
        return `<li><input type="checkbox" disabled${checked} /><span>${inner}</span></li>`;
      }
      return `<li>${inner}</li>`;
    },
  },

  text: {
    output(block: Block, ctx: OutputCtx): string {
      const b = block as ListBlock;
      const text = ctx.inline(b.charRuns, b.formats);
      if (b.type === "todo_list") {
        const checkbox = (b as TodoListItem).checked ? "[x]" : "[ ]";
        return `${checkbox} ${text}`;
      }
      return text;
    },
  },
};
