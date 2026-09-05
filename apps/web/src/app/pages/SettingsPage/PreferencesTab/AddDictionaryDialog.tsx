import { Upload } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Script } from "@tasfer/spell";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SpellService } from "@/spell/SpellService";
import {
  DictionaryImportError,
  type ImportBytes,
  type ImportProblem,
  inspectList,
  inspectPair,
  looksLikeAff,
  looksLikeDic,
} from "@/spell/userDictionaries";

/** What the chosen files turned out to be, once inspected. */
type Candidate =
  | { kind: "pair"; aff: ImportBytes; dic: ImportBytes; words?: never }
  | { kind: "list"; list: ImportBytes; words: number };

/**
 * Add a dictionary from disk: a Hunspell `.aff`/`.dic` pair or a plain word
 * list. The files are inspected before anything is written, so the name,
 * language and script it guessed can be corrected first.
 */
export function AddDictionaryDialog({
  service,
  open,
  onOpenChange,
  /** Pre-selected list (the personal dictionary sends over-cap imports here). */
  initialList,
}: {
  service: SpellService;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialList?: ImportBytes;
}) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [label, setLabel] = useState("");
  const [lang, setLang] = useState("");
  const [script, setScript] = useState<Script>("latn");
  const [problem, setProblem] = useState<ImportProblem | "needFiles" | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  /** The list handed in by the personal dictionary, consumed once per opening. */
  const [seeded, setSeeded] = useState<ImportBytes | undefined>();

  if (open && initialList && seeded !== initialList) {
    setSeeded(initialList);
    accept([initialList]);
  }
  if (!open && seeded) setSeeded(undefined);

  function reset() {
    setCandidate(null);
    setLabel("");
    setLang("");
    setScript("latn");
    setProblem(null);
  }

  function accept(files: ImportBytes[]) {
    setProblem(null);
    try {
      const aff = files.find((f) => looksLikeAff(f.bytes));
      const dic = files.find((f) => f !== aff && looksLikeDic(f.bytes));
      if (aff && dic) {
        const inferred = inspectPair(aff, dic);
        setCandidate({ kind: "pair", aff, dic });
        setLabel(inferred.label);
        setLang(inferred.lang);
        setScript(inferred.script);
        return;
      }
      if (files.length === 1) {
        const inferred = inspectList(files[0]);
        setCandidate({ kind: "list", list: files[0], words: inferred.words });
        setLabel(inferred.label);
        setLang(inferred.lang);
        setScript(inferred.script);
        return;
      }
      setCandidate(null);
      setProblem(aff ? "notDic" : "notAff");
    } catch (err) {
      setCandidate(null);
      setProblem(
        err instanceof DictionaryImportError ? err.problem : "needFiles",
      );
    }
  }

  async function onFiles(files: FileList) {
    const read: ImportBytes[] = [];
    for (const file of files) {
      read.push({
        name: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
    }
    accept(read);
  }

  async function add() {
    const store = service.imported;
    if (!candidate || !store) return;
    setBusy(true);
    try {
      const meta = { label, lang, script };
      if (candidate.kind === "pair") {
        await store.importPair(candidate.aff, candidate.dic, meta);
      } else {
        await store.importList(candidate.list, meta);
      }
      reset();
      onOpenChange(false);
    } catch (err) {
      setProblem(
        err instanceof DictionaryImportError ? err.problem : "needFiles",
      );
    } finally {
      setBusy(false);
    }
  }

  const problemText = (p: ImportProblem | "needFiles"): string => {
    switch (p) {
      case "tooLarge":
        return t(
          "settings.spelling.addDialog.tooLarge",
          "That file is too big to add.",
        );
      case "empty":
        return t("settings.spelling.addDialog.empty", "That file is empty.");
      case "notAff":
        return t(
          "settings.spelling.addDialog.notAff",
          "No affix file among those — a Hunspell dictionary needs its .aff as well as its .dic.",
        );
      case "notDic":
        return t(
          "settings.spelling.addDialog.notDic",
          "No dictionary file among those — a .dic starts with the number of words it holds.",
        );
      case "noWords":
        return t(
          "settings.spelling.addDialog.noWords",
          "That list has no words in it.",
        );
      default:
        return t(
          "settings.spelling.addDialog.needFiles",
          "Choose a .dic and .aff pair, or a single .txt word list.",
        );
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="flex flex-col gap-4">
        <DialogHeader>
          <DialogTitle>
            {t("settings.spelling.addDialog.title", "Add a dictionary")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "settings.spelling.addDialog.description",
              "A Hunspell .dic and .aff pair, or a .txt word list with one word per line. It stays on this device.",
            )}
          </DialogDescription>
        </DialogHeader>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".aff,.dic,.txt,text/plain"
          className="hidden"
          onChange={(e) => {
            const files = e.target.files;
            e.target.value = "";
            if (files?.length) void onFiles(files);
          }}
        />
        <Button
          type="button"
          variant="outline"
          className="self-start"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="size-4" aria-hidden />
          {t("settings.spelling.addDialog.choose", "Choose files")}
        </Button>

        {candidate && (
          <>
            <p className="text-sm text-muted-foreground">
              {candidate.kind === "pair"
                ? t(
                    "settings.spelling.addDialog.pairChosen",
                    "Hunspell dictionary: {{dic}} + {{aff}}",
                    { dic: candidate.dic.name, aff: candidate.aff.name },
                  )
                : t("settings.spelling.addDialog.listChosen", {
                    count: candidate.words,
                    file: candidate.list.name,
                    defaultValue_one: "Word list {{file}}: {{count}} word",
                    defaultValue_other: "Word list {{file}}: {{count}} words",
                  })}
            </p>
            <div className="flex flex-col gap-1">
              <label className="text-sm" htmlFor="spell-dict-label">
                {t("settings.spelling.addDialog.label", "Name")}
              </label>
              <Input
                id="spell-dict-label"
                dir="auto"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-sm" htmlFor="spell-dict-script">
                {t("settings.spelling.addDialog.script", "Writing system")}
              </label>
              <Select
                value={script}
                onValueChange={(v) => setScript(v as Script)}
              >
                <SelectTrigger id="spell-dict-script">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="latn">
                    {t("settings.spelling.script.latn", "Latin")}
                  </SelectItem>
                  <SelectItem value="arab">
                    {t("settings.spelling.script.arab", "Arabic")}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t(
                  "settings.spelling.addDialog.scriptHint",
                  "Words are only ever checked against dictionaries of their own writing system.",
                )}
              </p>
            </div>
          </>
        )}

        {problem && (
          <p className="text-sm text-destructive" role="alert">
            {problemText(problem)}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            {t("common.cancel", "Cancel")}
          </Button>
          <Button
            type="button"
            disabled={!candidate || busy}
            onClick={() => void add()}
          >
            {t("settings.spelling.addDialog.add", "Add dictionary")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
