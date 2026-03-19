import { Search, ChevronUp, ChevronDown, X } from "lucide-react";
import { useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";

interface FindBarProps {
  searchText: string;
  onSearchChange: (text: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
  currentMatch: number;
  totalMatches: number;
}

export function FindBar({
  searchText,
  onSearchChange,
  onNext,
  onPrevious,
  onClose,
  currentMatch,
  totalMatches,
}: FindBarProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Focus the input when the find bar opens
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) {
          onPrevious();
        } else {
          onNext();
        }
      }
    },
    [onNext, onPrevious]
  );

  return (
    <div
      className="absolute top-3 end-3 z-[1001] flex items-center gap-1.5 rounded-lg border border-border bg-background/95 px-3 py-1.5 shadow-lg backdrop-blur-sm"
      style={{ pointerEvents: "auto" }}
    >
      <Search size={14} className="shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        type="text"
        value={searchText}
        onChange={(e) => onSearchChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t("editor.find", "Find...")}
        className="w-48 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
      {searchText && (
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {totalMatches > 0
            ? `${currentMatch + 1}/${totalMatches}`
            : t("common.noResults", "No results")}
        </span>
      )}
      <button
        onClick={onPrevious}
        disabled={totalMatches === 0}
        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
        title={t("editor.previous", "Previous (Shift+Enter)")}
      >
        <ChevronUp size={16} />
      </button>
      <button
        onClick={onNext}
        disabled={totalMatches === 0}
        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
        title={t("editor.next", "Next (Enter)")}
      >
        <ChevronDown size={16} />
      </button>
      <button
        onClick={onClose}
        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        title={t("editor.closeEscape", "Close (Escape)")}
      >
        <X size={16} />
      </button>
    </div>
  );
}
