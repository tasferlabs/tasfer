import { usePageEventsWithQueryClient } from "@/websocket/hooks/usePageEvents";
import { useSpaceEventsWithQueryClient } from "@/websocket/hooks/useSpaceEvents";
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
import { zodResolver } from "@hookform/resolvers/zod";
import { FileTextIcon, PlusIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Ellipsis, PanelLeftClose } from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { z } from "zod";
import { Button } from "../../components/ui/button";
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
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../../components/ui/form";
import { Input } from "../../components/ui/input";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Textarea } from "../../components/ui/textarea";
import {
  useCreatePage,
  useMovePage,
  useReorderPage,
  type IListPage,
} from "../api/pages.api";
// import { useGetSharedByMe, useGetSharedWithMe } from "../api/shares.api";
import { getImageUrl } from "../api/images.api";
import { useCreateSpace, useLeaveSpace } from "../api/spaces.api";
import { useConfirmation } from "../components/ConfirmationDialog";
import { EditGroupDialog } from "../components/EditGroupDialog";
import { InviteMembersDialog } from "../components/InviteMembersDialog";
import Icons from "../components/uiKit/Icons/Icons";
import { useAuth } from "../contexts/AuthContext";
import { useSpaces } from "../contexts/SpaceContext";
import useResponsive from "../hooks/useResponsive";
import { setRecentDragEnd } from "./components/PageLink";
import { PagesArea } from "./components/PagesArea";
// import pageLinkStyle from "./components/PagesLinks.module.css";
import { useTranslation } from "react-i18next";
import { useSidebarPanel } from "../contexts/SidebarPanelContext";
import style from "./Layout.module.css";

export function SidebarContent({
  setOpen,
}: {
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const isMobile = useResponsive("(max-width: 768px)");
  const { getConfirmation } = useConfirmation();
  const { panelRef, hasPanel, setSlotMounted } = useSidebarPanel();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeDragData, setActiveDragData] = useState<IListPage | null>(null);

  // Dialog states — matching l4r PagesLayout pattern
  const [showAddGroupDialog, setShowAddGroupDialog] = useState(false);
  const [groupSettingsId, setGroupSettingsId] = useState<string | null>(null);
  const [inviteMembersId, setInviteMembersId] = useState<string | null>(null);
  // const [sharedCollapsed, setSharedCollapsed] = useState(false);

  // const { id: currentPageId } = useParams<{ id: string }>();
  const { user } = useAuth();
  const { personalSpace, groupSpaces } = useSpaces();
  // const { data: sharedWithMe } = useGetSharedWithMe();
  // const { data: sharedByMe } = useGetSharedByMe();

  // Subscribe to real-time page and space events from other users
  usePageEventsWithQueryClient();
  useSpaceEventsWithQueryClient();

  const { mutate: createPage, isPending: isCreating } = useCreatePage({
    onSuccess: (newPage, variables) => {
      queryClient.invalidateQueries({
        queryKey: [
          "pages",
          { spaceId: variables.spaceId, parentId: variables.parentId },
        ],
      });
      // Navigate to the newly created page
      navigate(`/page/${newPage.id}`);
    },
  });

  const { mutate: movePage } = useMovePage({
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: ["pages"] });
      const previousData = queryClient.getQueriesData<IListPage[]>({
        queryKey: ["pages"],
      });

      // Remove the page from whichever list it currently lives in
      queryClient.setQueriesData<IListPage[]>(
        { queryKey: ["pages"] },
        (old) => (old ? old.filter((p) => p.id !== variables.id) : old),
      );

      return { previousData };
    },
    onError: (_err, _variables, context) => {
      if (context?.previousData) {
        for (const [key, data] of context.previousData) {
          queryClient.setQueryData(key, data);
        }
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["pages"] });
    },
  });

  const { mutate: reorderPage } = useReorderPage({
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: ["pages"] });
      const previousData = queryClient.getQueriesData<IListPage[]>({
        queryKey: ["pages"],
      });

      // Update the order in-place and re-sort the list
      queryClient.setQueriesData<IListPage[]>(
        { queryKey: ["pages"] },
        (old) => {
          if (!old) return old;
          const idx = old.findIndex((p) => p.id === variables.id);
          if (idx === -1) return old;
          const updated = [...old];
          updated[idx] = { ...updated[idx], order: variables.order };
          updated.sort((a, b) => a.order - b.order);
          return updated;
        },
      );

      return { previousData };
    },
    onError: (_err, _variables, context) => {
      if (context?.previousData) {
        for (const [key, data] of context.previousData) {
          queryClient.setQueryData(key, data);
        }
      }
    },
    onSettled: () => {
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
      title: t("space.leaveSpace", "Leave space"),
      description: t("space.confirmLeaveSpace", "Are you sure you want to leave this space?"),
      confirmText: t("common.leave", "Leave"),
      cancelText: t("common.cancel", "Cancel"),
    });

    if (confirmed) {
      requestLeaveGroup(groupId);
    }
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
    setActiveDragData(event.active.data.current as IListPage);
  }

  // Helper to get a space's display name from its ID
  function getSpaceName(spaceId: string): string {
    if (personalSpace?.id === spaceId) return t("common.private", "Private");
    const group = groupSpaces.find((g) => g.id === spaceId);
    return group?.name || t("common.spaceKw", "space");
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    setActiveDragData(null);
    setRecentDragEnd();

    const { active, over } = event;

    if (!over) return;

    const activeData = active.data.current as IListPage & {
      spaceId?: string;
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

    // Detect cross-space move
    const sourceSpaceId = activeData.spaceId;
    const targetSpaceId = overData?.spaceId;
    const isCrossSpace = !!(
      sourceSpaceId &&
      targetSpaceId &&
      sourceSpaceId !== targetSpaceId
    );

    // If moving between spaces, ask for confirmation
    if (isCrossSpace) {
      const targetName = getSpaceName(targetSpaceId);
      const confirmed = await getConfirmation({
        title: t("page.movePage", "Move page"),
        description: t(
          'Move this page to "{{targetName}}"? All sub-pages will also be moved.',
          { targetName },
        ),
        confirmText: t("common.move", "Move"),
        cancelText: t("common.cancel", "Cancel"),
      });
      if (!confirmed) return;
    }

    // Build the spaceId param only when cross-space
    const spaceIdParam = isCrossSpace ? targetSpaceId : undefined;

    // Scenario 1: Drop on "before" zone
    if (overData?.type === "drop-zone" && overData.position === "before") {
      const targetParentId = overData.parentId;
      const targetOrder = overData.order;

      if (isCrossSpace || activeData.parentId !== targetParentId) {
        movePage({
          id: activeData.id,
          parentId: targetParentId,
          order: targetOrder,
          spaceId: spaceIdParam,
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

      if (isCrossSpace || activeData.parentId !== targetParentId) {
        movePage({
          id: activeData.id,
          parentId: targetParentId,
          order: targetOrder,
          spaceId: spaceIdParam,
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
          spaceId: spaceIdParam,
        });
      }
    }
    // Scenario 4: Drop on pages area
    else if (overData?.type === "pages-area") {
      const targetParentId = overData.parentId;

      if (isDescendant(activeData.id, targetParentId)) {
        return;
      }

      if (isCrossSpace || activeData.parentId !== targetParentId) {
        movePage({
          id: activeData.id,
          parentId: targetParentId,
          spaceId: spaceIdParam,
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

  const avatarUrl = user?.avatar ? getImageUrl(user.avatar) : null;

  return (
    <>
      {/* Portal target for page panels (e.g. calendar event preview) — replaces entire sidebar */}
      <div
        ref={(el) => {
          panelRef.current = el;
          setSlotMounted(!!el);
        }}
        className={clsx(style.sidebarPanelSlot, "bg-popover")}
        style={{ display: hasPanel ? "flex" : "none" }}
      />

      {!hasPanel && (
        <>
          <div className={clsx(style.appSidebarHeader, "gap-3")}>
            <div className="flex items-center gap-2 min-w-0 px-1.5 py-1 w-full">
              <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-medium shrink-0 overflow-hidden">
                {avatarUrl ? (
                  <img
                    src={avatarUrl}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                ) : (
                  initials
                )}
              </div>
              <span className="text-sm font-medium text-foreground truncate">
                {user?.name}
              </span>
            </div>

            <Button
              variant="ghost"
              size="icon-sm"
              className={clsx(
                "text-muted-foreground hover:text-foreground",
                style.appSidebarClose,
              )}
              onClick={() => setOpen(false)}
            >
              <PanelLeftClose className="h-4 w-4 rtl:-scale-x-100" />
              <span className="sr-only">{t("sidebar.close", "Close sidebar")}</span>
            </Button>
          </div>
          <div className={style.appNavigationLinks}>
            <RouterLink className={style.appNavigationLink} to={"/settings"}>
              <div className={style.appNavigationLinkIcon}>
                <Icons.Gear width={24} height={24} />
              </div>
              {t("settings.title", "Settings")}
            </RouterLink>
            <RouterLink className={style.appNavigationLink} to={"/calendar"}>
              <div className={style.appNavigationLinkIcon}>
                <Icons.Calendar width={24} height={24} />
              </div>
              {t("calendar.title", "Calendar")}
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
              {t("space.addSpace", "Add space")}
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
                        <DropdownMenuTrigger
                          className={style.appSidebarSectionButton}
                        >
                          <Ellipsis size={20} />
                          <span className="sr-only">{t("space.settings", "Space settings")}</span>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuItem
                            onSelect={(ev) => {
                              ev.preventDefault();
                              if (isMobile) setOpen(false);
                              setGroupSettingsId(group.id);
                            }}
                          >
                            {t("space.settings", "Space settings")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={(ev) => {
                              ev.preventDefault();
                              if (isMobile) setOpen(false);
                              setInviteMembersId(group.id);
                            }}
                          >
                            {t("share.inviteMembers", "Invite members")}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => leaveGroup(group.id)}
                          >
                            {t("space.leaveSpace", "Leave space")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <button
                        className={style.appSidebarSectionButton}
                        onClick={() => handleAdd(null, group.id)}
                        disabled={isCreating}
                      >
                        <PlusIcon size={20} />
                        <span className="sr-only">{t("page.addPage", "Add page")}</span>
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
                        {t("common.private", "Private")}
                      </div>
                      <button
                        className={style.appSidebarSectionButton}
                        onClick={() => handleAdd(null, personalSpace.id)}
                        disabled={isCreating}
                      >
                        <PlusIcon size={20} />
                        <span className="sr-only">{t("page.addPage", "Add page")}</span>
                      </button>
                    </div>

                    <PagesArea
                      className={style.appSidebarSectionPagesArea}
                      parentId={null}
                      spaceId={personalSpace.id}
                    />
                  </>
                )}
              </ScrollArea>
              <DragOverlay>
                {activeId && activeDragData ? (
                  <div className={style.dragOverlay}>
                    <FileTextIcon size={20} />
                    <span>{activeDragData.title || t("common.untitled", "Untitled")}</span>
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          </div>
        </>
      )}

      {/* Dialogs — rendered outside sidebar, matching l4r PagesLayout pattern */}
      <AddGroupDialog
        open={showAddGroupDialog}
        onOpenChange={setShowAddGroupDialog}
        onSubmit={(data) => createGroupSpace(data)}
      />
      <EditGroupDialog
        spaceId={groupSettingsId || ""}
        open={!!groupSettingsId}
        onOpenChange={(open) =>
          setGroupSettingsId(open ? groupSettingsId : null)
        }
        openInviteMembers={setInviteMembersId}
      />
      <InviteMembersDialog
        spaceId={inviteMembersId || ""}
        open={!!inviteMembersId}
        onOpenChange={(open) =>
          setInviteMembersId(open ? inviteMembersId : null)
        }
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
  const { t } = useTranslation();
  const isMobile = useResponsive("(max-width: 768px)");

  const FormSchema = useMemo(
    () =>
      z.object({
        name: z
          .string()
          .min(1, t("validation.spaceNameRequired", "Space name is required"))
          .min(3, t("validation.spaceNameTooShort", "Space name is too short"))
          .max(50, t("validation.spaceNameTooLong", "Space name is too long")),
        description: z.string().max(500, t("validation.descriptionTooLong", "Description is too long")),
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
          {t("space.createNewSpaceDesc", "Create a new space to share pages with others")}
        </p>

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

        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("common.description", "Description")}</FormLabel>
              <Textarea {...field} placeholder={t("common.description", "Description")} rows={3} />
              <FormMessage />
            </FormItem>
          )}
        />

        {isMobile ? null : (
          <DialogFooter>
            <Button type="submit">{t("common.create", "Create")}</Button>
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
              <DrawerTitle>{t("space.createNewSpace", "Create new space")}</DrawerTitle>
            </DrawerHeader>
            <div className="px-4">{content}</div>
            <DrawerFooter className="pt-4">
              <Button onClick={form.handleSubmit(handleSubmit)}>
                {t("common.create", "Create")}
              </Button>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("common.cancel", "Cancel")}
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
          <DialogTitle>{t("space.createNewSpace", "Create new space")}</DialogTitle>
        </DialogHeader>
        {content}
      </DialogContent>
    </Dialog>
  );
}
