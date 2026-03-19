import { useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormField,
  FormItem,
  FormMessage,
} from "@/components/ui/form";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { useAddSpaceMember } from "../api/spaces.api";
import useResponsive from "../hooks/useResponsive";

interface InviteMembersDialogProps {
  spaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function InviteMembersDialog({
  spaceId,
  open,
  onOpenChange,
}: InviteMembersDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const isMobile = useResponsive("(max-width: 768px)");

  const FormSchema = useMemo(
    () =>
      z.object({
        email: z.string().min(1, t("validation.emailIsRequired", "Email is required")).email(t("validation.invalidEmail", "Invalid email address")),
      }),
    [t],
  );

  const form = useForm<z.infer<typeof FormSchema>>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      email: "",
    },
  });

  const { mutate: addMember, isPending: isAdding } = useAddSpaceMember({
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["space-members", spaceId],
      });
      form.reset();
    },
    onError: (err) => form.setError("email", { message: err.message }),
  });

  useEffect(() => {
    if (open) {
      form.reset();
    }
  }, [open, form]);

  function onSubmit(data: z.infer<typeof FormSchema>) {
    addMember({ spaceId, email: data.email.trim() });
  }

  const content = (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {t("space.addMembersDesc", "Add members to this space by entering their email address.")}
        </p>

        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <Input
                {...field}
                type="email"
                placeholder={t("common.emailAddress", "Email address")}
              />
              <FormMessage />
            </FormItem>
          )}
        />

        <Button type="submit" loading={isAdding} className="w-full">
          {t("common.invite", "Invite")}
        </Button>
      </form>
    </Form>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent>
          <div className="mx-auto w-full max-w-sm pb-6">
            <DrawerHeader>
              <DrawerTitle>{t("share.inviteMembers", "Invite members")}</DrawerTitle>
            </DrawerHeader>
            <div className="px-4">{content}</div>
            <DrawerFooter className="pt-4">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("common.close", "Close")}
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
          <DialogTitle>{t("share.inviteMembers", "Invite members")}</DialogTitle>
          <DialogDescription>
            {t("share.invitePeople", "Invite people to collaborate in this space")}
          </DialogDescription>
        </DialogHeader>
        {content}
      </DialogContent>
    </Dialog>
  );
}
