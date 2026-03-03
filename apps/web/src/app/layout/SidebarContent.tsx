import { usePageEventsWithQueryClient } from "@/websocket/hooks/usePageEvents";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  CaretDoubleLeftIcon,
  FileTextIcon,
  PlusIcon,
  SignOutIcon,
  ShareNetworkIcon,
  SlidersHorizontalIcon,
  DotsThreeCircleIcon,
  DotsThreeIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import React, { useEffect, useMemo, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "../../components/ui/button";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../../components/ui/form";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "../../components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { ScrollArea } from "../../components/ui/scroll-area";
import {
  useCreatePage,
  useMovePage,
  useReorderPage,
  type IListPage,
} from "../api/pages.api";
import { useCreateSpace, useLeaveSpace } from "../api/spaces.api";
import { EditGroupDialog } from "../components/EditGroupDialog";
import { InviteMembersDialog } from "../components/InviteMembersDialog";
import { useConfirmation } from "../components/ConfirmationDialog";
import { useGetSharedWithMe } from "../api/shares.api";
import Icons from "../components/uiKit/Icons/Icons";
import VisuallyHidden from "../components/uiKit/VisuallyHidden/VisuallyHidden";
import { useAuth } from "../contexts/AuthContext";
import { useSpaces } from "../contexts/SpaceContext";
import useResponsive from "../hooks/useResponsive";
import { PagesArea } from "./components/PagesArea";
import { setRecentDragEnd } from "./components/PageLink";
import style from "./Layout.module.css";
import { Ellipsis, Settings } from "lucide-react";

// Mock t function
const t = (s: string | TemplateStringsArray) => s.toString();

export function SidebarContent({
  setOpen,
}: {
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const isMobile = useResponsive("(max-width: 768px)");
  const { getConfirmation } = useConfirmation();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeDragData, setActiveDragData] = useState<IListPage | null>(null);

  // Dialog states — matching l4r PagesLayout pattern
  const [showAddGroupDialog, setShowAddGroupDialog] = useState(false);
  const [groupSettingsId, setGroupSettingsId] = useState<string | null>(null);
  const [inviteMembersId, setInviteMembersId] = useState<string | null>(null);

  const { user, logout } = useAuth();
  const { personalSpace, groupSpaces } = useSpaces();
  const { data: sharedWithMe } = useGetSharedWithMe();

  // Subscribe to real-time page events from other users
  usePageEventsWithQueryClient();

  const { mutate: createPage, isPending: isCreating } = useCreatePage({
    onSuccess: (newPage, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["pages", { spaceId: variables.spaceId, parentId: variables.parentId }],
      });
      // Navigate to the newly created page
      navigate(`/page/${newPage.id}`);
    },
  });

  const { mutate: movePage } = useMovePage({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pages"] });
    },
  });

  const { mutate: reorderPage } = useReorderPage({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pages"] });
    },
  });

  const { mutate: createGroupSpace } = useCreateSpace({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["spaces"] });
    },
  });

  const { mutate: requestLeaveGroup } = useLeaveSpace({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["spaces"] });
      queryClient.invalidateQueries({ queryKey: ["pages"] });
    },
  });

  // Configure sensors with better mobile support and prevent accidental drags during scrolling
  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: {
        distance: 15,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 800,
        tolerance: 8,
      },
    }),
  );

  function handleAdd(parentId: string | null, spaceId: string) {
    createPage({
      title: "",
      parentId,
      spaceId,
    });
  }

  async function leaveGroup(groupId: string) {
    const confirmed = await getConfirmation({
      title: t`Leave group`,
      description: t`Are you sure you want to leave this group?`,
      confirmText: t`Leave`,
      cancelText: t`Cancel`,
    });

    if (confirmed) {
      requestLeaveGroup(groupId);
    }
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
    setActiveDragData(event.active.data.current as IListPage);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    setActiveDragData(null);
    setRecentDragEnd();

    const { active, over } = event;

    if (!over) return;

    const activeData = active.data.current as IListPage & {
      parentsStack?: any;
    };
    const overData = over.data.current as any;

    // Prevent dropping on the exact same dropzone
    if (active.id === over.id) {
      return;
    }

    // Helper function to check if targetId is a descendant of pageId
    const isDescendant = (pageId: string, targetId: string | null): boolean => {
      if (!targetId) return false;
      if (pageId === targetId) return true;

      // Check using parentsStack if available
      if (overData?.parentsStack) {
        return overData.parentsStack.some(
          (parent: any) => parent.id === pageId,
        );
      }

      return false;
    };

    // Prevent dropping a page into itself or its descendants
    if (overData?.type === "drop-zone" && overData.position === "inside") {
      if (isDescendant(activeData.id, overData.parentId)) {
        return;
      }
    }

    // For other drop zones, check if the parent is a descendant
    if (
      overData?.type === "drop-zone" &&
      (overData.position === "before" || overData.position === "after")
    ) {
      if (isDescendant(activeData.id, overData.targetPageId)) {
        return;
      }
      if (isDescendant(activeData.id, overData.parentId)) {
        return;
      }
    }

    // Scenario 1: Drop on "before" zone
    if (overData?.type === "drop-zone" && overData.position === "before") {
      const targetParentId = overData.parentId;
      const targetOrder = overData.order;

      if (activeData.parentId !== targetParentId) {
        movePage({
          id: activeData.id,
          parentId: targetParentId,
          order: targetOrder,
        });
      } else {
        if (targetOrder !== activeData.order) {
          reorderPage({
            id: activeData.id,
            order: targetOrder,
          });
        }
      }
    }
    // Scenario 2: Drop on "after" zone
    else if (overData?.type === "drop-zone" && overData.position === "after") {
      const targetParentId = overData.parentId;
      const targetOrder = overData.order;

      if (activeData.parentId !== targetParentId) {
        movePage({
          id: activeData.id,
          parentId: targetParentId,
          order: targetOrder,
        });
      } else {
        if (targetOrder !== activeData.order) {
          reorderPage({
            id: activeData.id,
            order: targetOrder,
          });
        }
      }
    }
    // Scenario 3: Drop on "inside" zone
    else if (overData?.type === "drop-zone" && overData.position === "inside") {
      const newParentId = overData.parentId;

      if (activeData.id !== newParentId) {
        movePage({
          id: activeData.id,
          parentId: newParentId,
        });
      }
    }
    // Scenario 4: Drop on pages area
    else if (overData?.type === "pages-area") {
      const targetParentId = overData.parentId;

      if (isDescendant(activeData.id, targetParentId)) {
        return;
      }

      if (activeData.parentId !== targetParentId) {
        movePage({
          id: activeData.id,
          parentId: targetParentId,
        });
      }
    }
  }

  // User initials for avatar
  const initials = user?.name
    ? user.name
        .split(" ")
        .map((w) => w[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "?";

  return (
    <>
      <div className={style.appSidebarHeader}>
        {/* User avatar with logout */}
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-medium shrink-0">
            {initials}
          </div>
          <span className="text-sm font-medium text-foreground truncate">
            {user?.name}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={logout}
            className={style.iconButton}
            title="Sign out"
          >
            <SignOutIcon size={20} />
            <VisuallyHidden>{t`Sign out`}</VisuallyHidden>
          </button>
          <button
            onClick={() => setOpen(false)}
            className={clsx(style.iconButton, style.appSidebarClose)}
          >
            <CaretDoubleLeftIcon size={24} />
            <VisuallyHidden>{t`Close sidebar`}</VisuallyHidden>
          </button>
        </div>
      </div>
      <div className={style.appNavigationLinks}>
        <RouterLink className={style.appNavigationLink} to={"/settings"}>
          <div className={style.appNavigationLinkIcon}>
            <Icons.Gear width={24} height={24} />
          </div>
          {t`Settings`}
        </RouterLink>
        <button
          className={style.appNavigationLink}
          onClick={() => {
            if (isMobile) setOpen(false);
            setShowAddGroupDialog(true);
          }}
        >
          <div className={style.appNavigationLinkIcon}>
            <Icons.AddGroup />
          </div>
          {t`Add group`}
        </button>
      </div>

      <div className={style.appSidebarMain}>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <ScrollArea className={style.appSidebarScrollArea}>
            {/* Group spaces */}
            {groupSpaces.map((group) => (
              <React.Fragment key={group.id}>
                <div className={style.appSidebarSection}>
                  <div className={style.appSidebarSectionTitle}>
                    <div className={style.appSidebarSectionIcon}>
                      <Icons.Shared />
                    </div>
                    {group.name}
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger className={style.appSidebarSectionButton}>
                      <Ellipsis size={20} />
                      <span className="sr-only">{t`Group settings`}</span>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem
                        onSelect={(ev) => {
                          ev.preventDefault();
                          if (isMobile) setOpen(false);
                          setGroupSettingsId(group.id);
                        }}
                      >
                        {t`Group settings`}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={(ev) => {
                          ev.preventDefault();
                          if (isMobile) setOpen(false);
                          setInviteMembersId(group.id);
                        }}
                      >
                        {t`Invite members`}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => leaveGroup(group.id)}>
                        {t`Leave group`}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <button
                    className={style.appSidebarSectionButton}
                    onClick={() => handleAdd(null, group.id)}
                    disabled={isCreating}
                  >
                    <PlusIcon size={20} />
                    <span className="sr-only">{t`Add page`}</span>
                  </button>
                </div>
                <PagesArea parentId={null} spaceId={group.id} />
              </React.Fragment>
            ))}

            {/* Personal space */}
            {personalSpace && (
              <>
                <div className={style.appSidebarSection}>
                  <div className={style.appSidebarSectionTitle}>
                    <div className={style.appSidebarSectionIcon}>
                      <Icons.Lock width={20} height={20} />
                    </div>
                    {t`Private`}
                  </div>
                  <button
                    className={style.appSidebarSectionButton}
                    onClick={() => handleAdd(null, personalSpace.id)}
                    disabled={isCreating}
                  >
                    <PlusIcon size={20} />
                    <span className="sr-only">{t`Add page`}</span>
                  </button>
                </div>

                <PagesArea
                  className={style.appSidebarSectionPagesArea}
                  parentId={null}
                  spaceId={personalSpace.id}
                />
              </>
            )}

            {/* Shared with me */}
            {sharedWithMe && sharedWithMe.length > 0 && (
              <>
                <div className={style.appSidebarSection}>
                  <div className={style.appSidebarSectionTitle}>
                    <div className={style.appSidebarSectionIcon}>
                      <ShareNetworkIcon size={20} />
                    </div>
                    {t`Shared with me`}
                  </div>
                </div>
                <div className="px-2 space-y-0.5">
                  {sharedWithMe.map((share) => (
                    <RouterLink
                      key={share.shareId}
                      to={`/page/${share.pageId}`}
                      className={clsx(
                        style.appNavigationLink,
                        "text-sm py-1.5 px-2"
                      )}
                    >
                      <FileTextIcon size={16} className="shrink-0" />
                      <span className="truncate">
                        {share.pageTitle || "Untitled"}
                      </span>
                    </RouterLink>
                  ))}
                </div>
              </>
            )}
          </ScrollArea>
          <DragOverlay>
            {activeId && activeDragData ? (
              <div className={style.dragOverlay}>
                <FileTextIcon size={20} />
                <span>{activeDragData.title || "Untitled"}</span>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      {/* Dialogs — rendered outside sidebar, matching l4r PagesLayout pattern */}
      <AddGroupDialog
        open={showAddGroupDialog}
        onOpenChange={setShowAddGroupDialog}
        onSubmit={(data) => createGroupSpace(data)}
      />
      <EditGroupDialog
        spaceId={groupSettingsId || ""}
        open={!!groupSettingsId}
        onOpenChange={(open) => setGroupSettingsId(open ? groupSettingsId : null)}
        openInviteMembers={setInviteMembersId}
      />
      <InviteMembersDialog
        spaceId={inviteMembersId || ""}
        open={!!inviteMembersId}
        onOpenChange={(open) => setInviteMembersId(open ? inviteMembersId : null)}
      />
    </>
  );
}

// --- Add Group Dialog (with name + description, like l4r AddGroupDialog) ---

function AddGroupDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: { name: string; description: string }) => void;
}) {
  const isMobile = useResponsive("(max-width: 768px)");

  const FormSchema = useMemo(
    () =>
      z.object({
        name: z
          .string()
          .min(1, t`Group name is required`)
          .min(3, t`Group name is too short`)
          .max(50, t`Group name is too long`),
        description: z.string().max(500, t`Description is too long`),
      }),
    [t],
  );

  const form = useForm<z.infer<typeof FormSchema>>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      name: "",
      description: "",
    },
  });

  useEffect(() => {
    if (open) {
      form.reset();
    }
  }, [open, form]);

  function handleSubmit(data: z.infer<typeof FormSchema>) {
    onSubmit(data);
    onOpenChange(false);
  }

  const content = (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {t`Create a new group to share pages with others`}
        </p>

        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t`Name`}</FormLabel>
              <Input {...field} placeholder={t`Group name`} />
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t`Description`}</FormLabel>
              <Textarea {...field} placeholder={t`Description`} rows={3} />
              <FormMessage />
            </FormItem>
          )}
        />

        {isMobile ? null : (
          <DialogFooter>
            <Button type="submit">{t`Create`}</Button>
          </DialogFooter>
        )}
      </form>
    </Form>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent>
          <div className="mx-auto w-full max-w-sm pb-6">
            <DrawerHeader>
              <DrawerTitle>{t`Create new group`}</DrawerTitle>
            </DrawerHeader>
            <div className="px-4">{content}</div>
            <DrawerFooter className="pt-4">
              <Button onClick={form.handleSubmit(handleSubmit)}>
                {t`Create`}
              </Button>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t`Cancel`}
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
          <DialogTitle>{t`Create new group`}</DialogTitle>
        </DialogHeader>
        {content}
      </DialogContent>
    </Dialog>
  );
}
