import { Editor } from "@tasfer/react";
import type { TasferEditor } from "@tasfer/editor";
import { foolscapTheme } from "../theme";
import { ClockIcon, EyeIcon, WaveIcon } from "./icons";

interface WritingStageProps {
  /** Markdown the editor opens with. */
  value: string;
  words: number;
  goal: number;
  /** "saved" | "saving" indicator state. */
  status: "saved" | "saving";
  /** mm:ss session clock. */
  clockLabel: string;
  onReady: (editor: TasferEditor) => void;
}

export function WritingStage({ value, words, goal, status, clockLabel, onReady }: WritingStageProps) {
  const pct = Math.min(100, Math.round((words / goal) * 100));

  return (
    <section className="stage">
      <header className="stage__topbar">
        <div className="stage__crumb">Saltwater · Chapter II</div>
        <div className="stage__tools">
          <div className="stage__ring" title={`${pct}% of today's goal`}>
            <div
              className="stage__ring-dial"
              style={{ background: `conic-gradient(#c0522f ${pct}%, #e4ddcd 0)` }}
            >
              <div className="stage__ring-hole" />
            </div>
            <span className="stage__ring-label">{pct}%</span>
          </div>
          <span className="stage__divider" />
          <span className="stage__icon">
            <EyeIcon />
          </span>
          <span className="stage__icon">
            <WaveIcon />
          </span>
        </div>
      </header>

      <div className="stage__scroll">
        <div className="stage__column">
          <div className="stage__page-eyebrow">Chapter Two</div>
          <h1 className="stage__page-title">Saltwater</h1>

          <div className="stage__editor">
            <Editor
              markdown={value}
              theme={foolscapTheme}
              autofocus
              ariaLabel="Saltwater, chapter two"
              onReady={onReady}
              style={{ height: "100%" }}
            />
          </div>

          <aside className="stage__margin-note" aria-hidden="true">
            <div className="stage__margin-note-head">
              <span className="stage__margin-avatar">E</span>
              <span>Note to self</span>
            </div>
            <div className="stage__margin-note-body">
              Revisit this metaphor — the clock feels a touch heavy so early.
            </div>
          </aside>
        </div>
      </div>

      <div className="stage__capsule">
        <span className="stage__capsule-item">
          <ClockIcon />
          <span className="stage__tnum">{clockLabel}</span>
        </span>
        <span className="stage__capsule-divider" />
        <span className="stage__capsule-item">{words.toLocaleString()} words today</span>
        <span className="stage__capsule-divider" />
        <span className="stage__capsule-saved">
          <span className={"stage__dot" + (status === "saving" ? " stage__dot--busy" : "")} />
          {status === "saving" ? "saving…" : "saved"}
        </span>
      </div>
    </section>
  );
}
