import { useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useUpdateSpace,
  useGetSpaceMembers,
  useRemoveSpaceMember,
  useLeaveSpace,
  type ISpace,
} from "../api/spaces.api";
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
        <TabsTrigger value="general">{t`General`}</TabsTrigger>
        <TabsTrigger value="members">{t`Members`}</TabsTrigger>
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
              <DrawerTitle>{t`Group settings`}</DrawerTitle>
            </DrawerHeader>
            <div className="px-4">{content}</div>
            <DrawerFooter className="pt-4">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t`Close`}
              </Button>
            </DrawerFooter>
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>{content}</DialogContent>
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
          .min(1, t`Group name is required`)
          .min(3, t`Group name is too short`)
          .max(50, t`Group name is too long`),
        description: z.string().max(500, t`Description is too long`),
      }),
    [t],
  );

  // Get the space data from the spaces query cache
  const spaces = queryClient.getQueryData<{
    owned: ISpace[];
    member: (ISpace & { role: string })[];
  }>(["spaces"]);
  const space =
    spaces?.owned.find((s) => s.id === spaceId) ??
    spaces?.member.find((s) => s.id === spaceId);

  const form = useForm<z.infer<typeof FormSchema>>({
    resolver: zodResolver(FormSchema),
    values: {
      name: space?.name || "",
      description: space?.description || "",
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
    updateSpace({ id: spaceId, name: data.name, description: data.description });
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">
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

        <Button
          type="submit"
          loading={isUpdating}
          className="w-full"
        >
          {t`Update`}
        </Button>
      </form>
    </Form>
  );
}

// --- Members Tab ---

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

  const { data: members, isLoading: isLoadingMembers } = useGetSpaceMembers(
    open ? spaceId : undefined,
  );

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

  const handleRoleChange = async (member: { id: string; userId: string }, value: string) => {
    const isMe = member.userId === user?.id;

    if (value === "remove") {
      if (isMe) {
        // Leave group
        const confirmed = await getConfirmation({
          title: t`Leave group`,
          description: t`Are you sure you want to leave this group?`,
          cancelText: t`Cancel`,
          confirmText: t`Leave`,
        });
        if (confirmed) {
          leaveSpace(spaceId);
        }
      } else {
        // Kick member
        const confirmed = await getConfirmation({
          title: t`Remove member`,
          description: t`Are you sure you want to remove this member from the group?`,
          cancelText: t`Cancel`,
          confirmText: t`Remove`,
        });
        if (confirmed) {
          removeMember({ spaceId, memberId: member.id });
        }
      }
    }
  };

  return (
    <div className="space-y-4 pt-4">
      {/* Members list */}
      <div className="space-y-2">
        {isLoadingMembers && (
          <p className="text-sm text-muted-foreground">{t`Loading...`}</p>
        )}
        {members?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {t`No members yet`}
          </p>
        )}
        {members?.map((member) => {
          const isMe = member.userId === user?.id;
          const isOwner = member.role === "owner";

          return (
            <div
              key={member.id}
              className="flex items-center justify-between rounded-md border p-2"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{member.userName}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {member.userEmail}
                </p>
              </div>
              <Select
                value={member.role}
                onValueChange={(v) => handleRoleChange(member, v)}
                disabled={isOwner}
              >
                <SelectTrigger className="w-24 h-8 text-xs shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="owner">{t`Owner`}</SelectItem>
                  <SelectItem value="editor">{t`Editor`}</SelectItem>
                  {!isOwner && (
                    <>
                      <SelectSeparator />
                      <SelectItem value="remove" className="text-destructive">
                        {isMe ? t`Leave` : t`Remove`}
                      </SelectItem>
                    </>
                  )}
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </div>

      <Button variant="secondary" onClick={openInviteMembers} className="w-full">
        {t`Invite members`}
      </Button>
    </div>
  );
}
