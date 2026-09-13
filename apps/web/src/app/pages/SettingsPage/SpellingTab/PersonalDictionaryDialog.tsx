import { BookPlus, Download, MoreVertical, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import useMobileLayout from "@/app/hooks/useMobileLayout";
import { cn } from "@/lib/utils";
import { downloadFile } from "@/downloadFile";
import type { SpellService } from "@/spell/SpellService";
import {
  type ImportBytes,
  PERSONAL_LIST_CAP,
  wordListSize,
} from "@/spell/userDictionaries";
import { useSpellServiceTick } from "./Spelling";

/** Height of one word row in pixels: a `text-sm` line plus its padding. */
const ROW_HEIGHT = 32;
/** Rows kept mounted past each edge of the viewport, so scrolling has slack. */
const OVERSCAN = 6;

/**
 * The person's own word list: search, remove per row, and a plain-text
 * import/export (one word per line, `#` comments, `!word` forbids). Words are
 * added from the text itself — right-click a flagged word — not from here.
 *
 * This list is one own-prefs key per word and syncs to every device, so a big
 * import belongs elsewhere: a file over {@link PERSONAL_LIST_CAP} words is
 * handed to `onTooManyWords`, which offers it as a device-local dictionary.
 */
export function PersonalDictionaryDialog({
  service,
  open,
  onOpenChange,
  onTooManyWords,
}: {
  service: SpellService;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTooManyWords?: (list: ImportBytes) => void;
}) {
  const { t, i18n } = useTranslation();
  const { isMobile } = useMobileLayout();
  const tick = useSpellServiceTick(service);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Collating the whole list is the expensive part, so it happens only when the
  // list itself changes — not on every keystroke in the search box.
  const sorted = useMemo(() => {
    const collator = new Intl.Collator(i18n.language, { sensitivity: "base" });
    return [...service.words()].sort((a, b) => collator.compare(a, b));
    // `service.words()` changes with the service tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, tick, i18n.language]);

  const words = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return q ? sorted.filter((w) => w.toLocaleLowerCase().includes(q)) : sorted;
  }, [sorted, query]);

  // Removing the last word takes the search box away with it; drop what was
  // typed too, so a word added later is not hidden by a filter nobody can see.
  useEffect(() => {
    if (sorted.length === 0) setQuery("");
  }, [sorted.length]);

  const importFile = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const text = new TextDecoder("utf-8").decode(bytes);
    const size = wordListSize(text);
    if (size > PERSONAL_LIST_CAP && onTooManyWords) {
      setNotice(
        t(
          "settings.spelling.dictionaryDialog.tooManyWords",
          "That list has {{words}} words — more than the {{max}} this list holds. Adding it as a dictionary of its own instead.",
          { words: size, max: PERSONAL_LIST_CAP },
        ),
      );
      onTooManyWords({ name: file.name, bytes });
      return;
    }
    const result: unknown = await Promise.resolve(service.importWords(text));
    const added =
      result && typeof result === "object" && "added" in result
        ? Number((result as { added: unknown }).added)
        : null;
    setNotice(
      added === null
        ? t("settings.spelling.dictionaryDialog.imported", "Words imported.")
        : t("settings.spelling.dictionaryDialog.importedCount", {
            count: added,
            defaultValue_one: "Added {{count}} word.",
            defaultValue_other: "Added {{count}} words.",
          }),
    );
  };

  const exportAll = async () => {
    const text = String(await Promise.resolve(service.exportWords()));
    await downloadFile(
      new Blob([text], { type: "text/plain" }),
      "tasfer-dictionary.txt",
      "text/plain",
    );
  };

  const title = t(
    "settings.spelling.dictionaryDialog.title",
    "Personal dictionary",
  );
  const description = t(
    "settings.spelling.dictionaryDialog.description",
    "Words in this list are never flagged on any of your devices.",
  );

  const body = (
    <>
      {/* Nothing to search until there is a list. */}
      {sorted.length > 0 && (
        <Input
          type="search"
          value={query}
          dir="auto"
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t(
            "settings.spelling.dictionaryDialog.search",
            "Search words",
          )}
          aria-label={t(
            "settings.spelling.dictionaryDialog.search",
            "Search words",
          )}
        />
      )}

      {sorted.length === 0 ? (
        // An empty list has nothing to scroll, so it gets a compact card
        // instead of a full-height box framing one sentence. Import sits here
        // rather than in the footer menu: it is the only thing to do from
        // inside the dialog until the first word arrives.
        <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-border px-6 py-8 text-center">
          <BookPlus className="size-6 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">
            {t("settings.spelling.dictionaryDialog.emptyTitle", "No words yet")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(
              "settings.spelling.dictionaryDialog.empty",
              "Right-click a flagged word in your text and choose “Add to dictionary”.",
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="size-4" aria-hidden />
            {t("settings.spelling.dictionaryDialog.import", "Import .txt")}
          </Button>
        </div>
      ) : words.length === 0 ? (
        <p className="rounded-md border border-border p-4 text-sm text-muted-foreground">
          {t(
            "settings.spelling.dictionaryDialog.noMatches",
            "No words match “{{query}}”.",
            { query: query.trim() },
          )}
        </p>
      ) : (
        <WordRows
          words={words}
          resetKey={query}
          removeLabel={(word) =>
            t("settings.spelling.dictionaryDialog.remove", "Remove {{word}}", {
              word,
            })
          }
          onRemove={(word) => service.removeWord(word)}
        />
      )}

      {/* A live region, so it stays mounted; it holds a line open only where a
          shifting layout would be felt — under a list, not under the card. */}
      <p
        className={cn(
          "text-xs text-muted-foreground",
          sorted.length > 0 && "min-h-[1.25rem]",
        )}
        role="status"
      >
        {notice}
      </p>
    </>
  );

  const filePicker = (
    <input
      ref={fileInputRef}
      type="file"
      accept=".txt,text/plain"
      className="hidden"
      onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (file) void importFile(file);
      }}
    />
  );

  // Import and export are the rare errand, not what this dialog is for, so they
  // sit behind the same overflow menu the language rows use rather than taking
  // the footer next to Done. An empty list has neither errand — nothing to
  // export, and import is offered in the empty card — so the menu stays away.
  const transferMenu =
    sorted.length === 0 ? null : (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t(
              "settings.spelling.dictionaryDialog.transfer",
              "Import or export",
            )}
          >
            <MoreVertical className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
            <Upload className="size-4" aria-hidden />
            {t("settings.spelling.dictionaryDialog.import", "Import .txt")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void exportAll()}>
            <Download className="size-4" aria-hidden />
            {t("settings.spelling.dictionaryDialog.export", "Export .txt")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent>
          <div className="flex min-h-0 flex-1 flex-col">
            <DrawerHeader>
              <DrawerTitle>{title}</DrawerTitle>
              <DrawerDescription>{description}</DrawerDescription>
            </DrawerHeader>
            <div className="flex min-h-0 flex-1 flex-col gap-4 px-4">
              {body}
            </div>
            {filePicker}
            <DrawerFooter>
              <div className="flex items-center gap-2">
                {transferMenu}
                <Button
                  type="button"
                  className="flex-1"
                  onClick={() => onOpenChange(false)}
                >
                  {t("common.done", "Done")}
                </Button>
              </div>
            </DrawerFooter>
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-4">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {body}
        {filePicker}

        <DialogFooter
          className={cn(
            "sm:items-center",
            transferMenu && "sm:justify-between",
          )}
        >
          {transferMenu}
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.done", "Done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The word rows, windowed: only the rows in view are mounted, so a list at the
 * {@link PERSONAL_LIST_CAP} costs the same to render as a list of ten. Rows are
 * a fixed {@link ROW_HEIGHT}, which is what lets the scroll offset alone say
 * which of them are on screen.
 */
function WordRows({
  words,
  resetKey,
  removeLabel,
  onRemove,
}: {
  words: string[];
  /** Scroll returns to the top whenever this changes — a new search. */
  resetKey: string;
  removeLabel: (word: string) => string;
  onRemove: (word: string) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    const observer = new ResizeObserver(() =>
      setViewportHeight(el.clientHeight),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    el.scrollTop = 0;
    setScrollTop(0);
  }, [resetKey]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(
    words.length,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
  );

  return (
    <div
      ref={viewportRef}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-md border border-border"
    >
      <ul className="relative" style={{ height: words.length * ROW_HEIGHT }}>
        {words.slice(first, last).map((word, i) => (
          <li
            key={word}
            style={{ top: (first + i) * ROW_HEIGHT, height: ROW_HEIGHT }}
            className={cn(
              "absolute inset-x-0 flex items-center justify-between gap-2 px-3 text-sm",
              first + i < words.length - 1 && "border-b border-border",
            )}
          >
            <span dir="auto" className="min-w-0 truncate">
              {word}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              aria-label={removeLabel(word)}
              onClick={() => onRemove(word)}
            >
              <X className="size-4" aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
