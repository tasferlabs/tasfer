import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { useAcceptInvite, cancelPairing } from "../api/spaces.api";
import type { SpaceInvite } from "@/platform/types";
import useResponsive from "../hooks/useResponsive";

interface JoinSpaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function decodeInvite(code: string): SpaceInvite | null {
  try {
    const json = atob(code.trim());
    const obj = JSON.parse(json);
    if (obj.topic && obj.secret && obj.spaceId) return obj as SpaceInvite;
    return null;
  } catch {
    return null;
  }
}

export function JoinSpaceDialog({ open, onOpenChange }: JoinSpaceDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const isMobile = useResponsive("(max-width: 768px)");
  const [status, setStatus] = useState<"input" | "connecting" | "done" | "error">("input");
  const [spaceName, setSpaceName] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const FormSchema = useMemo(
    () =>
      z.object({
        code: z.string().min(1, t("validation.required", "Required")).refine(
          (val) => decodeInvite(val) !== null,
          t("space.invalidInviteCode", "Invalid invite code"),
        ),
      }),
    [t],
  );

  const form = useForm<z.infer<typeof FormSchema>>({
    resolver: zodResolver(FormSchema),
    defaultValues: { code: "" },
  });

  const { mutate: acceptInvite } = useAcceptInvite({
    onError: (err) => {
      setStatus("error");
      setErrorMsg(err.message);
    },
  });

  useEffect(() => {
    if (open) {
      form.reset();
      setStatus("input");
      setSpaceName("");
      setErrorMsg("");
    }
    return () => {
      cancelPairing();
    };
  }, [open]);

  function onSubmit(data: z.infer<typeof FormSchema>) {
    const invite = decodeInvite(data.code);
    if (!invite) return;

    setSpaceName(invite.spaceName);
    setStatus("connecting");

    acceptInvite({
      invite,
      callbacks: {
        onConnected: () => {
          // Still connecting, verification in progress
        },
        onComplete: () => {
          setStatus("done");
          queryClient.invalidateQueries({ queryKey: ["spaces"] });
          queryClient.invalidateQueries({ queryKey: ["pages"] });
        },
        onError: (msg) => {
          setStatus("error");
          setErrorMsg(msg);
        },
      },
    });
  }

  const formContent = (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {t("space.pasteInviteCode", "Paste the invite code you received from a space member.")}
        </p>

        <FormField
          control={form.control}
          name="code"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("space.inviteCode", "Invite code")}</FormLabel>
              <Textarea
                {...field}
                placeholder={t("space.pasteCodeHere", "Paste code here...")}
                rows={3}
                className="font-mono text-xs break-all overflow-wrap-anywhere"
              />
              <FormMessage />
            </FormItem>
          )}
        />

        {!isMobile && (
          <DialogFooter>
            <Button type="submit">{t("space.joinSpace", "Join space")}</Button>
          </DialogFooter>
        )}
      </form>
    </Form>
  );

  const connectingContent = (
    <div className="flex flex-col items-center py-8 gap-3">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        {t("space.connectingToSpace", 'Connecting to "{{name}}"...', { name: spaceName })}
      </p>
    </div>
  );

  const doneContent = (
    <div className="text-center py-6">
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-green-100 dark:bg-green-900/30 mb-3">
        <Check className="h-6 w-6 text-green-600 dark:text-green-400" />
      </div>
      <p className="text-sm font-medium">
        {t("space.joinedSpace", 'Joined "{{name}}" successfully!', { name: spaceName })}
      </p>
    </div>
  );

  const errorContent = (
    <div className="text-center py-6">
      <p className="text-sm text-destructive">{errorMsg || t("common.error", "An error occurred")}</p>
      <Button
        variant="outline"
        size="sm"
        className="mt-3"
        onClick={() => setStatus("input")}
      >
        {t("common.tryAgain", "Try again")}
      </Button>
    </div>
  );

  const content = status === "input" ? formContent
    : status === "connecting" ? connectingContent
    : status === "done" ? doneContent
    : errorContent;

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent>
          <div className="mx-auto w-full max-w-sm pb-6">
            <DrawerHeader>
              <DrawerTitle>{t("space.joinSpace", "Join space")}</DrawerTitle>
            </DrawerHeader>
            <div className="px-4">{content}</div>
            <DrawerFooter className="pt-4">
              {status === "input" && (
                <Button onClick={form.handleSubmit(onSubmit)}>
                  {t("space.joinSpace", "Join space")}
                </Button>
              )}
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {status === "done" ? t("common.done", "Done") : t("common.cancel", "Cancel")}
              </Button>
            </DrawerFooter>
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("space.joinSpace", "Join space")}</DialogTitle>
        </DialogHeader>
        {content}
      </DialogContent>
    </Dialog>
  );
}
