import { useCallback, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/** Which occurrences of a repeating event a change applies to. */
export type RecurrenceScope = "this" | "following" | "all";

export type ScopeAction = "change" | "archive";

/**
 * Ask which occurrences a change to a repeating event or task covers. Returns
 * the prompt and the dialog element to render; the prompt resolves to the
 * choice, or null when it is dismissed. "This and following" is left out for
 * the first occurrence, where it would mean the same as "All pages".
 */
export function useRecurrenceScope(): [
  (
    action: ScopeAction,
    isFirst: boolean,
    isTask: boolean,
  ) => Promise<RecurrenceScope | null>,
  ReactNode,
] {
  const { t } = useTranslation();
  const [request, setRequest] = useState<{
    action: ScopeAction;
    isFirst: boolean;
    isTask: boolean;
  } | null>(null);
  const resolveRef = useRef<((scope: RecurrenceScope | null) => void) | null>(
    null,
  );

  const prompt = useCallback(
    (action: ScopeAction, isFirst: boolean, isTask: boolean) =>
      new Promise<RecurrenceScope | null>((resolve) => {
        // A prompt still open is answered "cancel" rather than left hanging.
        resolveRef.current?.(null);
        resolveRef.current = resolve;
        setRequest({ action, isFirst, isTask });
      }),
    [],
  );

  const settle = (scope: RecurrenceScope | null) => {
    resolveRef.current?.(scope);
    resolveRef.current = null;
    setRequest(null);
  };

  const isTask = !!request?.isTask;
  const choices: { scope: RecurrenceScope; label: string }[] = [
    {
      scope: "this",
      label: isTask
        ? t("calendar.repeat.scopeThisTask", "This task")
        : t("calendar.repeat.scopeThis", "This page"),
    },
    ...(request?.isFirst
      ? []
      : [
          {
            scope: "following" as const,
            label: isTask
              ? t(
                  "calendar.repeat.scopeFollowingTask",
                  "This and following tasks",
                )
              : t(
                  "calendar.repeat.scopeFollowing",
                  "This and following pages",
                ),
          },
        ]),
    {
      scope: "all",
      label: isTask
        ? t("calendar.repeat.scopeAllTask", "All tasks in the series")
        : t("calendar.repeat.scopeAll", "All pages in the series"),
    },
  ];

  const title =
    request?.action === "archive"
      ? isTask
        ? t("calendar.repeat.scopeArchiveTitleTask", "Archive repeating task")
        : t("calendar.repeat.scopeArchiveTitle", "Archive repeating page")
      : isTask
        ? t("calendar.repeat.scopeChangeTitleTask", "Change repeating task")
        : t("calendar.repeat.scopeChangeTitle", "Change repeating page");
  const body =
    request?.action === "archive"
      ? isTask
        ? t(
            "calendar.repeat.scopeArchiveBodyTask",
            "Which tasks should be archived?",
          )
        : t(
            "calendar.repeat.scopeArchiveBody",
            "Which pages should be archived?",
          )
      : isTask
        ? t(
            "calendar.repeat.scopeChangeBodyTask",
            "Which tasks should this change apply to?",
          )
        : t(
            "calendar.repeat.scopeChangeBody",
            "Which pages should this change apply to?",
          );

  const dialog = (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) settle(null);
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {choices.map((choice) => (
            <Button
              key={choice.scope}
              variant="outline"
              className="justify-start"
              onClick={() => settle(choice.scope)}
            >
              {choice.label}
            </Button>
          ))}
        </div>
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => settle(null)}>
            {t("common.cancel", "Cancel")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );

  return [prompt, dialog];
}
