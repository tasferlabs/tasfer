import { PagePicker } from "@/components/PagePicker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SpaceSelect } from "./SpaceSelect";
import { forkPageToSpace, movePageAcrossSpaces } from "@/lib/spaceMove";
import { useQueryClient } from "@tanstack/react-query";
import { GitFork, MoveRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { PopoverButton } from "@/components/ui/popover-button";
import { type ISearchPage, useMovePage } from "../api/pages.api";
import { useToast } from "./Toast";

interface MovePageDialogProps {
  /**
   * The pages to move, in the order they should land. More than one comes
   * from a sidebar multi-selection; they always share a space.
   */
  pages: { id: string; parentId: string | null }[];
  sourceSpaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MovePageDialog({
  pages,
  sourceSpaceId,
  open,
  onOpenChange,
}: MovePageDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { id: currentPageId } = useParams<{ id: string }>();
  const [selectedSpaceId, setSelectedSpaceId] = useState(sourceSpaceId);
  const [selectedParent, setSelectedParent] = useState<ISearchPage | null>(
    null,
  );
  const [isMovingAcrossSpaces, setIsMovingAcrossSpaces] = useState(false);
  const [isForking, setIsForking] = useState(false);

  const { mutateAsync: movePage, isPending: isMovingWithinSpace } =
    useMovePage();
  const isMoving = isMovingWithinSpace || isMovingAcrossSpaces;
  const isWorking = isMoving || isForking;
  const selectedParentId = selectedParent?.id ?? null;
  const count = pages.length;
  // Nothing to do only when every page is already sitting exactly there.
  const isSamePosition =
    selectedSpaceId === sourceSpaceId &&
    pages.every((p) => p.parentId === selectedParentId);

  useEffect(() => {
    if (!open) return;
    setSelectedSpaceId(sourceSpaceId);
    setSelectedParent(null);
  }, [open, sourceSpaceId]);

  function handleSpaceChange(spaceId: string) {
    setSelectedSpaceId(spaceId);
    setSelectedParent(null);
  }

  async function handleMove() {
    if (!selectedSpaceId || isSamePosition || isWorking) return;

    try {
      // One at a time, so a batch lands in the order it was listed: each move
      // appends to the end of the destination's children.
      if (selectedSpaceId === sourceSpaceId) {
        for (const page of pages) {
          await movePage({
            id: page.id,
            parentId: selectedParentId,
          });
        }
      } else {
        setIsMovingAcrossSpaces(true);
        for (const page of pages) {
          const { idMap } = await movePageAcrossSpaces(
            page.id,
            selectedSpaceId,
            { targetParentId: selectedParentId },
          );
          // The open page may have been inside this subtree: it now has a new
          // id, so follow it rather than leaving the editor on a dead route.
          if (currentPageId && idMap.has(currentPageId)) {
            navigate(`/page/${idMap.get(currentPageId)}`);
          }
        }
        queryClient.invalidateQueries({ queryKey: ["pages-archived"] });
      }

      queryClient.invalidateQueries({ queryKey: ["pages"] });
      queryClient.invalidateQueries({ queryKey: ["page"] });
      toast.success(t("page.moveDone", "Moved"));
      onOpenChange(false);
    } catch (error) {
      console.error("[MovePageDialog] move failed", error);
      toast.error(t("page.moveFailed", "Move failed"));
    } finally {
      setIsMovingAcrossSpaces(false);
    }
  }

  async function handleFork() {
    if (!selectedSpaceId || isWorking) return;

    setIsForking(true);
    try {
      let firstNewRootId: string | null = null;
      for (const page of pages) {
        const { newRootId } = await forkPageToSpace(page.id, selectedSpaceId, {
          targetParentId: selectedParentId,
        });
        if (newRootId) {
          queryClient.invalidateQueries({ queryKey: ["page", newRootId] });
          firstNewRootId ??= newRootId;
        }
      }

      queryClient.invalidateQueries({ queryKey: ["pages"] });
      // A batch has no one copy to land on, so the first stands for the rest.
      if (firstNewRootId) navigate(`/page/${firstNewRootId}`);
      toast.success(
        t("page.forkPagesDone", {
          count,
          defaultValue_one: "Page forked",
          defaultValue_other: "{{count, number}} pages forked",
        }),
      );
      onOpenChange(false);
    } catch (error) {
      console.error("[MovePageDialog] fork failed", error);
      toast.error(t("page.forkFailed", "Fork failed"));
    } finally {
      setIsForking(false);
    }
  }

  const actions = (
    <div className="grid gap-0.5">
      <Button
        onClick={handleMove}
        disabled={isSamePosition || isWorking}
        loading={isMoving}
        variant="unstyled"
        className="w-full justify-start gap-2 px-2.5 hover:bg-muted focus-visible:bg-muted"
      >
        <MoveRight className="text-primary rtl:rotate-180" />
        <span>
          {t("page.movePages", {
            count,
            defaultValue_one: "Move page",
            defaultValue_other: "Move pages",
          })}
        </span>
      </Button>

      <Button
        onClick={handleFork}
        disabled={isWorking}
        loading={isForking}
        variant="unstyled"
        className="w-full justify-start gap-2 px-2.5 hover:bg-muted focus-visible:bg-muted"
      >
        <GitFork className="text-muted-foreground" />
        <span>{t("page.fork", "Fork")}</span>
      </Button>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("page.movePages", {
              count,
              defaultValue_one: "Move page",
              defaultValue_other: "Move pages",
            })}
          </DialogTitle>
          <DialogDescription>
            {t("page.movePagesDescription", {
              count,
              defaultValue_one:
                "Choose a space and, optionally, a parent page. Sub-pages move with it.",
              defaultValue_other:
                "Choose a space and, optionally, a parent page. Sub-pages move with them.",
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <label className="grid gap-2">
            <span className="text-sm font-medium">
              {t("space.space", "Space")}
            </span>
            <SpaceSelect
              value={selectedSpaceId}
              onChange={handleSpaceChange}
              className="w-full"
            />
          </label>

          <label className="grid gap-2">
            <span className="text-sm font-medium">
              {t("page.parentPageOptional", "Parent page (optional)")}
            </span>
            <PagePicker
              spaceId={selectedSpaceId}
              value={selectedParent}
              onChange={setSelectedParent}
              excludeIds={
                selectedSpaceId === sourceSpaceId
                  ? pages.map((p) => p.id)
                  : undefined
              }
              showNoneOption
              noneLabel={t("page.spaceRoot", "Space root (no parent)")}
            />
          </label>

          <p className="text-muted-foreground text-xs">
            {t(
              "page.copyStartsFresh",
              "Forking a page, or moving it into another space, starts it fresh: the content comes along, but its version history stays behind.",
            )}
          </p>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isWorking}
          >
            {t("common.cancel", "Cancel")}
          </Button>
          <PopoverButton
            content={actions}
            contentProps={{
              className: "w-44 gap-0 rounded-lg p-1",
              sideOffset: 6,
            }}
            disabled={isWorking}
            popoverTriggerLabel={t("common.actions", "Actions")}
            primaryAction={{
              onClick: handleMove,
              disabled: isWorking || isSamePosition,
              loading: isMoving,
            }}
          >
            {t("page.movePage", "Move")}
          </PopoverButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
