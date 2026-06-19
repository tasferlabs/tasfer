import type { CypherEditor } from "@cypherkit/editor";
import { useEditorMarkdown } from "@cypherkit/react";
import { useEffect, useState } from "react";
import { ChaptersRail } from "./components/ChaptersRail";
import { WritingStage } from "./components/WritingStage";
import { clock, countWords } from "./util";

// The chapter the studio opens on. This seeds the *editable* canvas — type into
// it and every counter below updates live.
const SALTWATER = `The harbour kept its own time. Long before the town stirred, the boats had already gone, and the water closed over their wake as if nothing had ever left it at all.

She used to count them from the window — eleven, twelve, sometimes a stubborn thirteenth that ran late and came back heavy with the tide.

Her mother called it the only honest clock in the house, the one you couldn't argue with or wind back, and she was right in the way that the sea makes everyone right eventually.

By noon the salt had dried white on the railings, and you could taste the harbour on your own lips without ever going down to it.`;

const DAILY_GOAL = 1500;

export function App() {
  const [editor, setEditor] = useState<CypherEditor | null>(null);
  const markdown = useEditorMarkdown(editor);
  const words = editor ? countWords(markdown) : countWords(SALTWATER);

  // "saved" indicator: flips to "saving…" on edit, settles shortly after.
  const [status, setStatus] = useState<"saved" | "saving">("saved");
  useEffect(() => {
    if (!editor) return;
    let timer = 0;
    const off = editor.on("change", () => {
      setStatus("saving");
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setStatus("saved"), 700);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, [editor]);

  // A gently ticking session clock, opening mid-session like the design.
  const [seconds, setSeconds] = useState(24 * 60 + 18);
  useEffect(() => {
    const id = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="foolscap">
      <ChaptersRail words={words} goal={DAILY_GOAL} />
      <WritingStage
        value={SALTWATER}
        words={words}
        goal={DAILY_GOAL}
        status={status}
        clockLabel={clock(seconds)}
        onReady={setEditor}
      />
    </div>
  );
}
