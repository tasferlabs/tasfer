import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, MoreVertical, Pause, Play } from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useUpdateSpace,
  useGetSpace,
  useGetSpaceMembers,
  useCanMakeSpacePersonal,
  useMakeSpacePersonal,
  type ISpace,
} from "../api/spaces.api";
import { useConfirmation } from "./ConfirmationDialog";
import { useToast } from "./Toast";
import { useAssetUrl } from "../api/images.api";
import { useAuth } from "../contexts/AuthContext";
import { AvatarPreviewDialog } from "./AvatarPreviewDialog";
import { RelativeDate } from "@/components/ui/relative-date";
import { getDisplayName } from "@tasfer/provider-core/cursors";
import { cn } from "@/lib/utils";
import { DeviceCountBadge } from "./DeviceCountBadge";
import type { ISpaceMember, ISpacePerson } from "../api/spaces.api";
import { getMemberSyncStatus, useSetMemberSyncPaused } from "../api/spaces.api";
import useMobileLayout from "../hooks/useMobileLayout";

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
  const { isMobile } = useMobileLayout();
  // An edited-but-unsaved name, reported up from the tab that owns the field so
  // the drawer can refuse to be swiped away over it. The footer's Close button
  // stays the deliberate way out.
  const [nameEdited, setNameEdited] = useState(false);

  const content = (
    <Tabs defaultValue="general">
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="general">{t("common.general", "General")}</TabsTrigger>
        <TabsTrigger value="members">{t("space.sharing", "Sharing")}</TabsTrigger>
      </TabsList>
      <TabsContent value="general">
        <GeneralTab
          spaceId={spaceId}
          open={open}
          onEditedChange={setNameEdited}
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
      <Drawer open={open} onOpenChange={onOpenChange} dirty={nameEdited}>
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
  onEditedChange,
}: {
  spaceId: string;
  open: boolean;
  /** Reports an unsaved edit to the name, which pins the drawer open. */
  onEditedChange: (edited: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const FormSchema = useMemo(
    () =>
      z.object({
        name: z
          .string()
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

  // Mirror the field's dirty state up to the drawer; a tab switch or a close
  // unmounts this form, and the edit goes with it, so drop the guard too.
  const nameEdited = form.formState.isDirty;
  useEffect(() => {
    onEditedChange(nameEdited);
    return () => onEditedChange(false);
  }, [nameEdited, onEditedChange]);

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
  deviceCount = 1,
}: {
  avatar?: string | null;
  name?: string | null;
  onClick: (event: React.MouseEvent) => void;
  presence?: Presence;
  /** Devices this person is in the space from — counted on a corner badge. */
  deviceCount?: number;
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
      {/* Top corner: the presence dot already owns the bottom one. */}
      <DeviceCountBadge count={deviceCount} placement="top" />
      {presence === "online" && (
        <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full bg-green-500 ring-2 ring-background" />
      )}
    </div>
  );
}

/** Disclosure chevron, pointing at the content it opens in either direction. */
function DisclosureChevron({ expanded }: { expanded: boolean }) {
  return (
    <ChevronDown
      className={cn(
        "size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
        !expanded && "-rotate-90 rtl:rotate-90",
      )}
    />
  );
}

/**
 * A person's devices carry no name of their own — every one of them publishes
 * the same profile. The key fragment is what tells two of them apart.
 */
function deviceFingerprint(publicKey: string): string {
  return publicKey.slice(0, 6);
}

function DeviceRow({
  device,
  isSelf,
}: {
  device: ISpaceMember;
  /** The device this app is running on, named rather than fingerprinted. */
  isSelf: boolean;
}) {
  const { t } = useTranslation();
  const online = getPresence(device.lastSeen) === "online";
  return (
    <li className="flex items-center gap-2 py-1 text-xs">
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          online ? "bg-green-500" : "bg-muted-foreground/40",
        )}
      />
      <span className="truncate">
        {isSelf ? (
          t("space.thisDevice", "This device")
        ) : (
          <span className="font-mono">{deviceFingerprint(device.id)}</span>
        )}
      </span>
      <span className="ms-auto shrink-0 text-muted-foreground">
        {device.lastSeen ? (
          <RelativeDate date={device.lastSeen} />
        ) : (
          t("space.noActivity", "No activity")
        )}
      </span>
    </li>
  );
}

/**
 * Pause or resume syncing with one member — every device of theirs at once,
 * since the register holds the person rather than the machine they happened to
 * join from.
 *
 * Person-private, reversible, and not access control: they keep their place in
 * the space, they are never told, and in a space with other members the same
 * changes can still reach them by another route. What it buys is one fewer
 * connection for this person's devices to keep alive — worth spending on a
 * member who is never coming back, not on one who is merely quiet.
 */
function MemberSyncButton({
  spaceId,
  member,
}: {
  spaceId: string;
  member: ISpacePerson;
}) {
  const { t } = useTranslation();
  const { getConfirmation } = useConfirmation();
  const { mutate, isPending } = useSetMemberSyncPaused();
  // A member who never set a name still has to be nameable in a question about
  // them, which a row showing an empty string does not have to be.
  const name = getDisplayName(
    { name: member.userName },
    t("collaboration.anonymous", "Anonymous"),
  );

  async function handleChange(paused: boolean) {
    if (paused) {
      // What they were last known to hold and we never got: the one part of
      // this decision the person cannot see for themselves.
      const status = await getMemberSyncStatus(member);
      const stranded = status.unsyncedOps ?? 0;
      const confirmed = await getConfirmation({
        title: t("space.pauseSyncTitle", "Pause syncing with {{name}}?", {
          name,
        }),
        description:
          stranded > 0
            ? t("space.pauseSyncBodyPending", {
                count: stranded,
                defaultValue_one:
                  "Your devices stop connecting to theirs until you resume. They stay in the space, and they last reported {{count, number}} change this device never received — paused, it can only reach you through another member.",
                defaultValue_other:
                  "Your devices stop connecting to theirs until you resume. They stay in the space, and they last reported {{count, number}} changes this device never received — paused, those can only reach you through another member.",
              })
            : t(
                "space.pauseSyncBody",
                "Your devices stop connecting to theirs until you resume. They stay in the space, and in a shared space your changes can still reach them through another member.",
              ),
        confirmText: t("space.pauseSyncConfirm", "Pause"),
        cancelText: t("common.cancel", "Cancel"),
      });
      if (!confirmed) return;
    }
    mutate({ spaceId, member, paused });
  }

  // A menu rather than a switch: pausing is a decision that opens a question and
  // takes effect once answered, not a setting that flips under the finger. It
  // hides behind the dots because it is the rare errand on a row whose ordinary
  // job is to show who is here — and because a row carrying its own verb reads
  // as if that verb were the point of the row.
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={isPending}
          aria-label={t("space.memberActions", "Actions for {{name}}", { name })}
        >
          <MoreVertical className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {member.syncPaused ? (
          <DropdownMenuItem onSelect={() => handleChange(false)}>
            <Play className="size-4" aria-hidden />
            {t("space.resume", "Resume")}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => handleChange(true)}>
            <Pause className="size-4" aria-hidden />
            {t("space.pauseSyncConfirm", "Pause")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MemberRow({
  member,
  spaceId,
  dimmed,
  onPreview,
  selfDeviceId,
}: {
  member: ISpacePerson;
  spaceId: string;
  dimmed?: boolean;
  onPreview: (avatar: string, name: string | null) => void;
  /** Public key of the device this app runs on, when known. */
  selfDeviceId?: string;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const presence = getPresence(member.lastSeen);
  // Paused devices are left out here. This list answers where in the space a
  // person is reachable, and a device this person has set aside is not one of
  // those places — listed, it would read as somewhere their changes can still
  // arrive from, and its ageing timestamp would tell that story more loudly
  // every day. Resuming one is Settings → Profile's job, which is where they
  // are kept to hand.
  //
  // Pausing a whole person marks every device of theirs, so their row folds
  // down to nothing here — which is right: they are already sitting in the
  // Paused group, where the row itself is the thing to act on.
  const devices = useMemo(
    () => member.devices.filter((device) => !device.syncPaused),
    [member.devices],
  );

  // Counted the same way for the same reason: a count is a count of what the
  // list shows, or opening it makes a liar of one of the two.
  const deviceCount = devices.length;
  // One device is the row itself — there is no tree to open under it.
  const expandable = deviceCount > 1;
  const devicesId = `member-devices-${member.id}`;
  const deviceLabel = t("common.deviceCount", {
    count: deviceCount,
    defaultValue_one: "{{count, number}} device",
    defaultValue_other: "{{count, number}} devices",
  });

  const summary = (
    <>
      <MemberAvatar
        avatar={member.userAvatar}
        name={member.userName}
        presence={presence}
        deviceCount={deviceCount}
        onClick={(event) => {
          if (!member.userAvatar) return;
          // Inside an expandable row the avatar keeps its own job: opening the
          // picture, not the device list.
          event.stopPropagation();
          onPreview(member.userAvatar, member.userName);
        }}
      />
      <div className="min-w-0 flex-1 text-start">
        <p className="text-sm font-medium truncate">{member.userName}</p>
        <p className="text-xs text-muted-foreground truncate">
          {member.lastSeen ? (
            <RelativeDate date={member.lastSeen} />
          ) : (
            t("space.noActivity", "No activity")
          )}
          {deviceCount > 1 && <> · {deviceLabel}</>}
        </p>
      </div>
      {expandable && (
        <span className="text-muted-foreground">
          <DisclosureChevron expanded={expanded} />
        </span>
      )}
    </>
  );

  // The card is the wrapper, so the dots sit inside it rather than stranded
  // beside it. What the card holds still splits in two: a button covering the
  // whole summary, and the menu alongside — an expandable row is itself a
  // button, and a button cannot nest in one.
  const cardClass = cn(
    "flex w-full min-w-0 items-center gap-1 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/50",
    (dimmed || member.syncPaused) && "opacity-60",
  );
  const summaryClass = "flex min-w-0 flex-1 items-center gap-3 text-start";

  // This person's own row has nothing to pause here: their devices are theirs,
  // and Settings → Profile is where those are paused.
  const isSelf = member.devices.some((device) => device.id === selfDeviceId);

  return (
    <div>
      <div className={cardClass}>
        {expandable ? (
          <button
            type="button"
            className={summaryClass}
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-controls={devicesId}
          >
            {summary}
          </button>
        ) : (
          <div className={summaryClass}>{summary}</div>
        )}
        {!isSelf && <MemberSyncButton spaceId={spaceId} member={member} />}
      </div>

      {expandable && (
        // Grid rows animate from nothing to content height without the height
        // having to be measured.
        <div
          id={devicesId}
          // Collapsed rows stay mounted for the animation, so take them out of
          // the reading and tabbing order rather than just hiding them.
          inert={!expanded}
          className={cn(
            "grid transition-[grid-template-rows] duration-200 motion-reduce:transition-none",
            expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <ul
            className="overflow-hidden ms-6 border-s border-border/70 ps-3.5"
            aria-label={t("space.devicesHeading", "Devices")}
          >
            {devices.map((device) => (
              <DeviceRow
                key={device.id}
                device={device}
                isSelf={device.id === selfDeviceId}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Top level of the tree: an activity group. It only becomes a toggle when
 * there is another group to weigh it against — a lone group is just a label.
 */
function GroupHeader({
  label,
  count,
  expanded,
  onToggle,
  controls,
}: {
  label: string;
  count: number;
  expanded?: boolean;
  onToggle?: () => void;
  controls?: string;
}) {
  const className =
    "flex w-full items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground";

  if (!onToggle) {
    return (
      <p className={cn(className, "pb-1")}>
        {label} · {count}
      </p>
    );
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(className, "transition-colors hover:text-foreground")}
      aria-expanded={expanded}
      aria-controls={controls}
    >
      <DisclosureChevron expanded={!!expanded} />
      <span>{label}</span>
      <span className="opacity-70">· {count}</span>
    </button>
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

  const [showActive, setShowActive] = useState(true);
  const [showInactive, setShowInactive] = useState(false);
  const [showPaused, setShowPaused] = useState(false);
  // Naming the device this app runs on beats fingerprinting it.
  const { user: self } = useAuth();

  const { data: members, isLoading: isLoadingMembers } = useGetSpaceMembers(
    open ? spaceId : undefined,
  );
  const { data: space } = useGetSpace(open ? spaceId : undefined);

  const { getConfirmation } = useConfirmation();
  const { toast } = useToast();
  // Asked of the platform, never re-derived here: the rule is enforced in the
  // engine, and a second copy of it in the UI would be the one that goes stale.
  const { data: canMakePersonal } = useCanMakeSpacePersonal(
    open ? spaceId : undefined,
  );
  const { mutate: makePersonal, isPending: isMakingPersonal } =
    useMakeSpacePersonal({
      onError: () =>
        toast.error(
          t("space.makePersonalFailed", "Could not make this space personal"),
        ),
    });

  // The warning lives in the confirm step rather than beside the button: this
  // is the only door in the app that does not open again, and a line of small
  // print under a button is not where someone reads that.
  async function handleMakePersonal() {
    const confirmed = await getConfirmation({
      title: t("space.makePersonal", "Make personal"),
      description: t(
        "space.makePersonalConfirm",
        "Only your devices will open this space. This can't be undone.",
      ),
      confirmText: t("space.makePersonal", "Make personal"),
      cancelText: t("common.cancel", "Cancel"),
    });
    if (confirmed) makePersonal(spaceId);
  }

  const handlePreview = (avatar: string, name: string | null) =>
    setPreviewMember({ avatar, name });

  // Split by activity tier so stale / never-seen members can be folded away
  // instead of bloating the list. Each group is sorted most-recent-first.
  const { active, inactive, paused } = useMemo(() => {
    const byRecent = (a: ISpaceMember, b: ISpaceMember) => {
      if (!a.lastSeen && !b.lastSeen) return 0;
      if (!a.lastSeen) return 1;
      if (!b.lastSeen) return -1;
      return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
    };
    const active: ISpacePerson[] = [];
    const inactive: ISpacePerson[] = [];
    const paused: ISpacePerson[] = [];
    for (const member of members ?? []) {
      // Paused takes the member out of the activity tiers entirely. It is a
      // decision this person made rather than something the member did, and
      // this is the group they will come back to when they want it undone —
      // so it must not depend on how recently that member happened to be seen.
      if (member.syncPaused) paused.push(member);
      else if (getPresence(member.lastSeen) === "inactive") inactive.push(member);
      else active.push(member);
    }
    return {
      active: active.sort(byRecent),
      inactive: inactive.sort(byRecent),
      paused: paused.sort(byRecent),
    };
  }, [members]);

  const hasMembers =
    active.length > 0 || inactive.length > 0 || paused.length > 0;
  // With nobody active, keep the folded groups open so the panel isn't empty.
  const inactiveExpanded = showInactive || active.length === 0;
  const pausedExpanded =
    showPaused || (active.length === 0 && inactive.length === 0);

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
            <GroupHeader
              label={t("space.active", "Active")}
              count={active.length}
              expanded={showActive}
              onToggle={() => setShowActive((v) => !v)}
              controls="space-members-active"
            />
          )}
          <div id="space-members-active" className="space-y-0.5">
            {(showActive || inactive.length === 0) &&
              active.map((member) => (
                <MemberRow
                  key={member.id}
                  member={member}
                  spaceId={spaceId}
                  onPreview={handlePreview}
                  selfDeviceId={self?.id}
                />
              ))}
          </div>
        </div>
      )}

      {inactive.length > 0 && (
        <div className="space-y-0.5">
          <GroupHeader
            label={t("space.inactive", "Inactive")}
            count={inactive.length}
            expanded={inactiveExpanded}
            onToggle={
              active.length > 0 ? () => setShowInactive((v) => !v) : undefined
            }
            controls="space-members-inactive"
          />
          <div id="space-members-inactive" className="space-y-0.5">
            {inactiveExpanded &&
              inactive.map((member) => (
                <MemberRow
                  key={member.id}
                  member={member}
                  spaceId={spaceId}
                  dimmed
                  onPreview={handlePreview}
                  selfDeviceId={self?.id}
                />
              ))}
          </div>
        </div>
      )}

      {paused.length > 0 && (
        <div className="space-y-0.5">
          <GroupHeader
            label={t("space.pausedGroup", "Paused")}
            count={paused.length}
            expanded={pausedExpanded}
            onToggle={
              active.length > 0 || inactive.length > 0
                ? () => setShowPaused((v) => !v)
                : undefined
            }
            controls="space-members-paused"
          />
          <div id="space-members-paused" className="space-y-0.5">
            {pausedExpanded &&
              paused.map((member) => (
                <MemberRow
                  key={member.id}
                  member={member}
                  spaceId={spaceId}
                  onPreview={handlePreview}
                  selfDeviceId={self?.id}
                />
              ))}
          </div>
        </div>
      )}

      {space?.personal ? (
        <p className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
          {t(
            "space.personalSpaceMembersNote",
            "This space is yours alone. Only your own devices can open it, and it cannot be shared.",
          )}
        </p>
      ) : (
        <div className="space-y-2">
          <Button variant="secondary" onClick={openInviteMembers} className="w-full">
            {t("share.inviteMembers", "Invite members")}
          </Button>
          {canMakePersonal === true && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-muted-foreground"
              loading={isMakingPersonal}
              onClick={handleMakePersonal}
            >
              {t("space.makePersonal", "Make personal")}
            </Button>
          )}
        </div>
      )}

      <AvatarPreviewDialog
        open={!!previewMember}
        onOpenChange={(open) => { if (!open) setPreviewMember(null); }}
        imageUrl={previewAvatarUrl}
        name={previewMember?.name}
      />
    </div>
  );
}
