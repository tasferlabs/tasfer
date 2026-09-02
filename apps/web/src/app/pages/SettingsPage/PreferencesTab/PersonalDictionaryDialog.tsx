import { Download, Upload, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { downloadFile } from "@/downloadFile";
import type { SpellService } from "@/spell/SpellService";
import { useSpellServiceTick } from "./SpellingSettings";

/**
 * The person's own word list: search, add (Enter), remove per row, and a
 * plain-text import/export (one word per line, `#` comments, `!word` forbids).
 */
export function PersonalDictionaryDialog({
  service,
  open,
  onOpenChange,
}: {
  service: SpellService;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  useSpellServiceTick(service);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const words = useMemo(() => {
    const all = service.words();
    const collator = new Intl.Collator(i18n.language, { sensitivity: "base" });
    const sorted = [...all].sort((a, b) => collator.compare(a, b));
    const q = query.trim().toLocaleLowerCase();
    return q ? sorted.filter((w) => w.toLocaleLowerCase().includes(q)) : sorted;
    // `service.words()` changes with the service tick above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, query, i18n.language, service.words().length]);

  const addDraft = () => {
    const word = draft.trim();
    if (!word) return;
    service.addWord(word);
    setDraft("");
    setNotice(
      t("spell.announce.added", "Added {{word}} to your dictionary", { word }),
    );
  };

  const importFile = async (file: File) => {
    const text = await file.text();
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-4">
        <DialogHeader>
          <DialogTitle>
            {t(
              "settings.spelling.dictionaryDialog.title",
              "Personal dictionary",
            )}
          </DialogTitle>
          <DialogDescription>
            {t(
              "settings.spelling.dictionaryDialog.description",
              "Words you add here are never flagged, on any of your devices.",
            )}
          </DialogDescription>
        </DialogHeader>

        <Input
          type="search"
          value={query}
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

        <div className="flex gap-2">
          <Input
            value={draft}
            dir="auto"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addDraft();
              }
            }}
            placeholder={t(
              "settings.spelling.dictionaryDialog.addPlaceholder",
              "Add a word and press Enter",
            )}
            aria-label={t("settings.spelling.dictionaryDialog.add", "Add word")}
          />
          <Button type="button" variant="secondary" onClick={addDraft}>
            {t("settings.spelling.dictionaryDialog.add", "Add word")}
          </Button>
        </div>

        <ScrollArea className="min-h-0 flex-1 rounded-md border border-border">
          {words.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              {query.trim()
                ? t(
                    "settings.spelling.dictionaryDialog.noMatches",
                    "No words match “{{query}}”.",
                    { query: query.trim() },
                  )
                : t(
                    "settings.spelling.dictionaryDialog.empty",
                    "No words yet. Right-click a flagged word and choose “Add to dictionary”.",
                  )}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {words.map((word) => (
                <li
                  key={word}
                  className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm"
                >
                  <span dir="auto" className="min-w-0 truncate">
                    {word}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    aria-label={t(
                      "settings.spelling.dictionaryDialog.remove",
                      "Remove {{word}}",
                      { word },
                    )}
                    onClick={() => service.removeWord(word)}
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>

        <p
          className="min-h-[1.25rem] text-xs text-muted-foreground"
          role="status"
        >
          {notice}
        </p>

        <DialogFooter className="sm:justify-between">
          <div className="flex gap-2">
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
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="size-4" aria-hidden />
              {t("settings.spelling.dictionaryDialog.import", "Import .txt")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={service.words().length === 0}
              onClick={() => void exportAll()}
            >
              <Download className="size-4" aria-hidden />
              {t("settings.spelling.dictionaryDialog.export", "Export .txt")}
            </Button>
          </div>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.done", "Done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
