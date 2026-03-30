import { useEffect, useMemo, useState } from "react";
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
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useUpdateSpace,
  useGetSpaceMembers,
  useRemoveSpaceMember,
  useLeaveSpace,
  type ISpace,
} from "../api/spaces.api";
import { useAssetUrl } from "../api/images.api";
import { AvatarPreviewDialog } from "./AvatarPreviewDialog";
import { RelativeDate } from "@/components/ui/relative-date";
import { useAuth } from "../contexts/AuthContext";
import { useConfirmation } from "./ConfirmationDialog";
import useResponsive from "../hooks/useResponsive";

interface EditGroupDialogProps {
  spaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  openInviteMembers: (spaceId: string) => void;
}

export function EditGroupDialog({
  spaceId,
  open,
  onOpenChange,
  openInviteMembers,
}: EditGroupDialogProps) {
  const { t } = useTranslation();
  const isMobile = useResponsive("(max-width: 768px)");

  const content = (
    <Tabs defaultValue="general">
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="general">{t("common.general", "General")}</TabsTrigger>
        <TabsTrigger value="members">{t("space.members", "Members")}</TabsTrigger>
      </TabsList>
      <TabsContent value="general">
        <GeneralTab
          spaceId={spaceId}
          open={open}
        />
      </TabsContent>
      <TabsContent value="members">
        <MembersTab
          spaceId={spaceId}
          open={open}
          openInviteMembers={() => {
            onOpenChange(false);
            openInviteMembers(spaceId);
          }}
        />
      </TabsContent>
    </Tabs>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent>
          <div className="mx-auto w-full max-w-sm pb-6">
            <DrawerHeader>
              <DrawerTitle>{t("space.settings", "Space settings")}</DrawerTitle>
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
        <DialogTitle className="sr-only">{t("space.settings", "Space settings")}</DialogTitle>
        {content}
      </DialogContent>
    </Dialog>
  );
}

// --- General Tab ---

function GeneralTab({
  spaceId,
  open,
}: {
  spaceId: string;
  open: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const FormSchema = useMemo(
    () =>
      z.object({
        name: z
          .string()
          .min(1, t("validation.spaceNameRequired", "Space name is required"))
          .min(3, t("validation.spaceNameTooShort", "Space name is too short"))
          .max(50, t("validation.spaceNameTooLong", "Space name is too long")),
      }),
    [t],
  );

  // Get the space data from the spaces query cache
  const spaces = queryClient.getQueryData<ISpace[]>(["spaces"]);
  const space = spaces?.find((s) => s.id === spaceId);

  const form = useForm<z.infer<typeof FormSchema>>({
    resolver: zodResolver(FormSchema),
    values: {
      name: space?.name || "",
    },
  });

  const { mutate: updateSpace, isPending: isUpdating } = useUpdateSpace({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["spaces"] });
    },
  });

  useEffect(() => {
    if (open) {
      form.reset();
    }
  }, [open]);

  function onSubmit(data: z.infer<typeof FormSchema>) {
    updateSpace({ id: spaceId, name: data.name });
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("common.name", "Name")}</FormLabel>
              <Input {...field} placeholder={t("space.spaceName", "Space name")} />
              <FormMessage />
            </FormItem>
          )}
        />

        <Button
          type="submit"
          loading={isUpdating}
          className="w-full"
        >
          {t("common.update", "Update")}
        </Button>
      </form>
    </Form>
  );
}

// --- Members Tab ---

function MemberAvatar({ avatar, name, onClick }: { avatar?: string | null; name?: string | null; onClick: () => void }) {
  const avatarUrl = useAssetUrl(avatar);
  return (
    <div
      className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-medium shrink-0 overflow-hidden"
      style={{ cursor: avatar ? "pointer" : undefined }}
      onClick={onClick}
    >
      {avatarUrl ? (
        <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
      ) : (
        name?.charAt(0).toUpperCase() || "?"
      )}
    </div>
  );
}

function MembersTab({
  spaceId,
  open,
  openInviteMembers,
}: {
  spaceId: string;
  open: boolean;
  openInviteMembers: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { getConfirmation } = useConfirmation();
  const { user } = useAuth();

  const [previewMember, setPreviewMember] = useState<{
    avatar: string;
    name: string | null;
  } | null>(null);
  const previewAvatarUrl = useAssetUrl(previewMember?.avatar);

  const { data: members, isLoading: isLoadingMembers } = useGetSpaceMembers(
    open ? spaceId : undefined,
  );

  // Snapshot sort by lastSeen desc when data first loads; does not re-sort on re-renders
  const sortedMembers = useMemo(() => {
    if (!members) return members;
    return [...members].sort((a, b) => {
      if (!a.lastSeen && !b.lastSeen) return 0;
      if (!a.lastSeen) return 1;
      if (!b.lastSeen) return -1;
      return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
    });
  }, [members]);

  const { mutate: removeMember } = useRemoveSpaceMember({
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["space-members", spaceId],
      });
    },
  });

  const { mutate: leaveSpace } = useLeaveSpace({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["spaces"] });
      queryClient.invalidateQueries({ queryKey: ["pages"] });
    },
  });

  const handleRemoveMember = async (member: { id: string; userId: string }) => {
    const isMe = member.userId === user?.id;

    if (isMe) {
      const confirmed = await getConfirmation({
        title: t("space.leaveSpace", "Leave space"),
        description: t("space.confirmLeaveSpace", "Are you sure you want to leave this space?"),
        cancelText: t("common.cancel", "Cancel"),
        confirmText: t("common.leave", "Leave"),
      });
      if (confirmed) {
        leaveSpace(spaceId);
      }
    } else {
      const confirmed = await getConfirmation({
        title: t("space.removeMember", "Remove member"),
        description: t("space.confirmRemoveMember", "Are you sure you want to remove this member from this space?"),
        cancelText: t("common.cancel", "Cancel"),
        confirmText: t("common.remove", "Remove"),
      });
      if (confirmed) {
        removeMember({ spaceId, memberId: member.id });
      }
    }
  };

  return (
    <div className="space-y-4 pt-4">
      {/* Members list */}
      <div className="space-y-2">
        {isLoadingMembers && (
          <p className="text-sm text-muted-foreground">{t("common.loading", "Loading...")}</p>
        )}
        {sortedMembers?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {t("space.noMembers", "No members yet")}
          </p>
        )}
        {sortedMembers?.map((member) => {
          const isMe = member.userId === user?.id;

          return (
            <div
              key={member.id}
              className="flex items-center justify-between rounded-md border p-2 gap-2"
            >
              <MemberAvatar
                avatar={member.userAvatar}
                name={member.userName}
                onClick={() =>
                  member.userAvatar &&
                  setPreviewMember({
                    avatar: member.userAvatar,
                    name: member.userName,
                  })
                }
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{member.userName}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {member.lastSeen ? (
                    <RelativeDate date={member.lastSeen} />
                  ) : (
                    t("space.noActivity", "No activity")
                  )}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-destructive shrink-0"
                onClick={() => handleRemoveMember(member)}
              >
                {isMe ? t("common.leave", "Leave") : t("common.remove", "Remove")}
              </Button>
            </div>
          );
        })}
      </div>

      <Button variant="secondary" onClick={openInviteMembers} className="w-full">
        {t("share.inviteMembers", "Invite members")}
      </Button>

      <AvatarPreviewDialog
        open={!!previewMember}
        onOpenChange={(open) => { if (!open) setPreviewMember(null); }}
        imageUrl={previewAvatarUrl}
        name={previewMember?.name}
      />
    </div>
  );
}
