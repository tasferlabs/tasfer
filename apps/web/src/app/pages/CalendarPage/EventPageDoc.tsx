import {
  bodyBlocksWindow,
  titleBlockIndex,
  type Block,
  type Doc,
} from "@tasfer/editor";
import {
  cleanSnapshotForSave,
  getBlockTextLength,
  type TextStyle,
} from "@tasfer/editor/internal";
import type { PageFrontier } from "@/platform/types";
import { getAppFontRegistry } from "@/fonts";
import { Type } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { AppMountedEditor } from "../../../editorSchema";
import {
  fontStyleToFamily,
  usePageSettings,
} from "../../contexts/PageSettingsContext";
import { MountedEditor, PageDocScope } from "../../MountedEditor";
import { TitleEditor } from "../../TitleEditor";
import type { CollaborativeDoc } from "../../useCollaborativeDoc";
import style from "./CalendarPage.module.css";

// Stateless, so one instance serves every preview.
const BODY_WINDOW = bodyBlocksWindow();

type BodyEditor = AppMountedEditor["editor"];

interface EventPageDocProps {
  pageId: string;
  /**
   * The page's space. Edits reach other devices live only through it; without
   * one they are saved here but never sent.
   */
  spaceId?: string;
  snapshot: Block[];
  frontier?: PageFrontier;
  /** Gets the whole page (title included) after each local edit, to save. */
  onContentChange: (blocks: Block[]) => void;
  onEditorReady?: (editor: BodyEditor | null) => void;
  /** Focus the title on open. Phones skip it so the keyboard stays down. */
  autoFocusTitle: boolean;
  padding?: Partial<{
    paddingTop: number;
    paddingBottom: number;
    paddingLeft: number;
    paddingRight: number;
  }>;
  blockStyleOverrides?: Partial<Record<string, Partial<TextStyle>>> | null;
  /** Places the two halves: the title field and the body editor. */
  children: (title: ReactNode, body: ReactNode) => ReactNode;
}

/**
 * An event's own page, split the way a draft is: the title in a field of its
 * own, and the rest of the page in a body editor. Both are views on one shared
 * doc, so they stay in sync with each other and with the full page.
 */
export function EventPageDoc({ children, ...props }: EventPageDocProps) {
  return (
    <PageDocScope
      key={props.pageId}
      pageId={props.pageId}
      spaceId={props.spaceId}
      snapshot={props.snapshot}
      frontier={props.frontier}
      readonly={false}
    >
      {(collab) => (
        <EventPageDocViews {...props} collab={collab}>
          {children}
        </EventPageDocViews>
      )}
    </PageDocScope>
  );
}

function hasBody(doc: Doc): boolean {
  return BODY_WINDOW.select(doc.getRawBlocks()).size > 0;
}

/** A body that is only one empty line — nothing to read yet. */
function isBodyBlankLine(doc: Doc): boolean {
  const blocks = doc.getRawBlocks();
  const body = [...BODY_WINDOW.select(blocks)];
  if (body.length !== 1) return false;
  const block = blocks[body[0]];
  return block.type === "paragraph" && getBlockTextLength(block) === 0;
}

function EventPageDocViews({
  pageId,
  snapshot,
  frontier,
  onContentChange,
  onEditorReady,
  autoFocusTitle,
  padding,
  blockStyleOverrides,
  children,
  collab,
}: EventPageDocProps & { collab: CollaborativeDoc }) {
  const { t } = useTranslation();
  const { fontStyle } = usePageSettings();
  const doc = collab.doc;
  const bodyEditorRef = useRef<BodyEditor | null>(null);
  const [bodyEditor, setBodyEditor] = useState<BodyEditor | null>(null);

  // A page that is only its title has an empty body window: the canvas has no
  // line to paint a placeholder on, so a hint stands in until the first body
  // line exists. From then on the editor's own "Add notes" placeholder takes
  // over, in the same place.
  const [bodyMissing, setBodyMissing] = useState(() => !hasBody(doc));
  const [bodyBlankLine, setBodyBlankLine] = useState(() =>
    isBodyBlankLine(doc),
  );
  useEffect(() => {
    const sync = () => {
      setBodyMissing(!hasBody(doc));
      setBodyBlankLine(isBodyBlankLine(doc));
    };
    sync();
    return doc.on("update", sync);
  }, [doc]);

  // Empty lines in the notes read "Add notes". The engine shows a placeholder
  // only in the caret's line; while the notes are one blank line it shows
  // there with or without the caret, as a text field's placeholder does.
  const notesPlaceholder = t("calendar.addNotes", "Add notes");
  useEffect(() => {
    bodyEditor?.setTheme({
      styles: {
        placeholder: {
          paragraph: {
            keyboardCompatibleText: notesPlaceholder,
            touchCompatiableText: notesPlaceholder,
          },
          showUnfocused: bodyBlankLine,
        },
      },
    });
  }, [bodyEditor, notesPlaceholder, bodyBlankLine]);

  // The body editor sees title edits as remote and won't report them, so the
  // title field reports its own.
  const handleTitleChange = useCallback(() => {
    onContentChange(cleanSnapshotForSave(doc.getRawBlocks()));
  }, [doc, onContentChange]);

  const handleBodyEditorReady = useCallback(
    (editor: BodyEditor | null) => {
      bodyEditorRef.current = editor;
      setBodyEditor(editor);
      onEditorReady?.(editor);
    },
    [onEditorReady],
  );

  // Move to the body, giving it a first line when there is none — as Enter at
  // the end of a title does on the full page.
  const focusBody = useCallback(() => {
    const editor = bodyEditorRef.current;
    if (!editor) return;
    if (!hasBody(doc)) {
      const blocks = doc.getRawBlocks();
      const title = blocks[titleBlockIndex(blocks)];
      editor.change((c) => {
        c.insertBlock(
          { type: "paragraph" },
          title ? { block: title.id, side: "after" } : "end",
        );
      });
    }
    editor.focus();
  }, [doc]);

  const title = (
    <div className={style.previewTitleRow}>
      <Type size={14} className={style.previewRowIcon} aria-hidden />
      <TitleEditor
        doc={doc}
        autoFocus={autoFocusTitle}
        onChange={handleTitleChange}
        onSubmit={focusBody}
        placeholder={t("calendar.addTitle", "Add title")}
      />
    </div>
  );

  const body = (
    <div className="relative h-full">
      <MountedEditor
        collab={collab}
        viewWindow={BODY_WINDOW}
        snapshot={snapshot}
        frontier={frontier}
        pageId={pageId}
        onContentChange={onContentChange}
        onEditorReady={handleBodyEditorReady}
        // The editor's canvas layers carry their own z-index; isolating them
        // keeps the empty-body hint below on top of them, so it gets the click.
        className="h-full isolate"
        padding={padding}
        blockStyleOverrides={blockStyleOverrides}
      />
      {bodyMissing && (
        <button
          type="button"
          className={style.previewBodyHint}
          // Set where and how the canvas paints its placeholder, so the hint
          // and the editor's own "Add notes" line up when one replaces the other.
          style={{
            paddingTop: padding?.paddingTop,
            paddingInline: padding?.paddingLeft,
            fontFamily:
              getAppFontRegistry().families[fontStyleToFamily(fontStyle)],
          }}
          onClick={focusBody}
        >
          {notesPlaceholder}
        </button>
      )}
    </div>
  );

  return <>{children(title, body)}</>;
}
