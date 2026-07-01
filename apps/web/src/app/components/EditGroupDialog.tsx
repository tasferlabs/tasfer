import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
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
  type ISpace,
} from "../api/spaces.api";
import { useAssetUrl } from "../api/images.api";
import { AvatarPreviewDialog } from "./AvatarPreviewDialog";
import { RelativeDate } from "@/components/ui/relative-date";
import { cn } from "@/lib/utils";
import type { ISpaceMember } from "../api/spaces.api";
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

// Activity tiers derived from a member's last-seen timestamp.
// "online" earns a live presence dot; "active" stays in the main list;
// "inactive" (stale or never seen) is folded into the collapsed group.
type Presence = "online" | "active" | "inactive";

const ONLINE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getPresence(lastSeen: string | null): Presence {
  if (!lastSeen) return "inactive";
  const elapsed = Date.now() - new Date(lastSeen).getTime();
  if (Number.isNaN(elapsed)) return "inactive";
  if (elapsed <= ONLINE_WINDOW_MS) return "online";
  if (elapsed <= ACTIVE_WINDOW_MS) return "active";
  return "inactive";
}

function MemberAvatar({
  avatar,
  name,
  onClick,
  presence,
}: {
  avatar?: string | null;
  name?: string | null;
  onClick: () => void;
  presence?: Presence;
}) {
  const avatarUrl = useAssetUrl(avatar);
  return (
    <div className="relative shrink-0">
      <div
        className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-medium overflow-hidden"
        style={{ cursor: avatar ? "pointer" : undefined }}
        onClick={onClick}
      >
        {avatarUrl ? (
          <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          name?.charAt(0).toUpperCase() || "?"
        )}
      </div>
      {presence === "online" && (
        <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full bg-green-500 ring-2 ring-background" />
      )}
    </div>
  );
}

function MemberRow({
  member,
  dimmed,
  onPreview,
}: {
  member: ISpaceMember;
  dimmed?: boolean;
  onPreview: (avatar: string, name: string | null) => void;
}) {
  const { t } = useTranslation();
  const presence = getPresence(member.lastSeen);
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/50",
        dimmed && "opacity-60",
      )}
    >
      <MemberAvatar
        avatar={member.userAvatar}
        name={member.userName}
        presence={presence}
        onClick={() =>
          member.userAvatar && onPreview(member.userAvatar, member.userName)
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

  const [previewMember, setPreviewMember] = useState<{
    avatar: string;
    name: string | null;
  } | null>(null);
  const previewAvatarUrl = useAssetUrl(previewMember?.avatar);

  const [showInactive, setShowInactive] = useState(false);

  const { data: members, isLoading: isLoadingMembers } = useGetSpaceMembers(
    open ? spaceId : undefined,
  );

  const handlePreview = (avatar: string, name: string | null) =>
    setPreviewMember({ avatar, name });

  // Split by activity tier so stale / never-seen members can be folded away
  // instead of bloating the list. Each group is sorted most-recent-first.
  const { active, inactive } = useMemo(() => {
    const byRecent = (a: ISpaceMember, b: ISpaceMember) => {
      if (!a.lastSeen && !b.lastSeen) return 0;
      if (!a.lastSeen) return 1;
      if (!b.lastSeen) return -1;
      return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
    };
    const active: ISpaceMember[] = [];
    const inactive: ISpaceMember[] = [];
    for (const member of members ?? []) {
      if (getPresence(member.lastSeen) === "inactive") inactive.push(member);
      else active.push(member);
    }
    return {
      active: active.sort(byRecent),
      inactive: inactive.sort(byRecent),
    };
  }, [members]);

  const hasMembers = active.length > 0 || inactive.length > 0;
  // With nobody active, keep the inactive group open so the panel isn't empty.
  const inactiveExpanded = showInactive || active.length === 0;

  return (
    <div className="space-y-4 pt-4">
      {isLoadingMembers && (
        <p className="text-sm text-muted-foreground">{t("common.loading", "Loading...")}</p>
      )}
      {!isLoadingMembers && !hasMembers && (
        <p className="text-sm text-muted-foreground">
          {t("space.noMembers", "No members yet")}
        </p>
      )}

      {active.length > 0 && (
        <div className="space-y-0.5">
          {inactive.length > 0 && (
            <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {t("space.active", "Active")} · {active.length}
            </p>
          )}
          {active.map((member) => (
            <MemberRow key={member.id} member={member} onPreview={handlePreview} />
          ))}
        </div>
      )}

      {inactive.length > 0 && (
        <div className="space-y-0.5">
          {active.length > 0 ? (
            <button
              type="button"
              onClick={() => setShowInactive((v) => !v)}
              className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
              aria-expanded={inactiveExpanded}
            >
              <ChevronDown
                className={cn(
                  "size-3.5 transition-transform",
                  !inactiveExpanded && "-rotate-90",
                )}
              />
              <span>{t("space.inactive", "Inactive")}</span>
              <span className="opacity-70">· {inactive.length}</span>
            </button>
          ) : (
            <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {t("space.inactive", "Inactive")} · {inactive.length}
            </p>
          )}
          {inactiveExpanded &&
            inactive.map((member) => (
              <MemberRow key={member.id} member={member} dimmed onPreview={handlePreview} />
            ))}
        </div>
      )}

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
