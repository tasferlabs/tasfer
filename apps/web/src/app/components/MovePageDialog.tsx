import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { GitFork, LoaderCircle, Move } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { PagePicker } from "@/components/PagePicker";
import { Button } from "@/components/ui/button";
import { PopoverButton } from "@/components/ui/popover-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { forkPageToSpace, movePageAcrossSpaces } from "@/lib/spaceMove";
import { type ISearchPage, useMovePage } from "../api/pages.api";
import { useSpaces } from "../contexts/SpaceContext";
import { useToast } from "./Toast";

interface MovePageDialogProps {
  pageId: string;
  currentParentId: string | null;
  sourceSpaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MovePageDialog({
  pageId,
  currentParentId,
  sourceSpaceId,
  open,
  onOpenChange,
}: MovePageDialogProps) {
  const { t } = useTranslation();
  const { spaces } = useSpaces();
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
  const isSamePosition =
    selectedSpaceId === sourceSpaceId &&
    selectedParentId === currentParentId;

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
      if (selectedSpaceId === sourceSpaceId) {
        await movePage({
          id: pageId,
          parentId: selectedParentId,
        });
      } else {
        setIsMovingAcrossSpaces(true);
        const { idMap } = await movePageAcrossSpaces(
          pageId,
          selectedSpaceId,
          { targetParentId: selectedParentId },
        );
        queryClient.invalidateQueries({ queryKey: ["pages-archived"] });
        if (currentPageId && idMap.has(currentPageId)) {
          navigate(`/page/${idMap.get(currentPageId)}`);
        }
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
      const { newRootId } = await forkPageToSpace(pageId, selectedSpaceId, {
        targetParentId: selectedParentId,
      });

      queryClient.invalidateQueries({ queryKey: ["pages"] });
      if (newRootId) {
        queryClient.invalidateQueries({ queryKey: ["page", newRootId] });
        navigate(`/page/${newRootId}`);
      }
      toast.success(t("page.forkDone", "Page forked"));
      onOpenChange(false);
    } catch (error) {
      console.error("[MovePageDialog] fork failed", error);
      toast.error(t("page.forkFailed", "Fork failed"));
    } finally {
      setIsForking(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("page.movePage", "Move page")}</DialogTitle>
          <DialogDescription>
            {t(
              "page.movePageDescription",
              "Choose a space and parent page. Sub-pages move with it.",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <label className="grid gap-2">
            <span className="text-sm font-medium">
              {t("space.space", "Space")}
            </span>
            <Select value={selectedSpaceId} onValueChange={handleSpaceChange}>
              <SelectTrigger className="w-full">
                <SelectValue
                  placeholder={t("space.selectSpace", "Select space")}
                />
              </SelectTrigger>
              <SelectContent>
                {spaces.map((space) => (
                  <SelectItem key={space.id} value={space.id}>
                    {space.name || t("common.untitled", "Untitled")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <label className="grid gap-2">
            <span className="text-sm font-medium">
              {t("page.parentPageOptional", "Parent page (optional)")}
            </span>
            <PagePicker
              spaceId={selectedSpaceId}
              value={selectedParent}
              onChange={setSelectedParent}
              excludeId={
                selectedSpaceId === sourceSpaceId ? pageId : undefined
              }
              showNoneOption
              noneLabel={t("page.spaceRoot", "Space root (no parent)")}
            />
          </label>
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
            disabled={!selectedSpaceId || isWorking}
            contentProps={{ className: "w-72 gap-1 p-1" }}
            content={
              <>
                <Button
                  variant="ghost"
                  className="w-full justify-start"
                  onClick={handleMove}
                  disabled={isSamePosition || isWorking}
                >
                  <Move />
                  {t("common.move", "Move")}
                </Button>
                <Button
                  variant="ghost"
                  className="h-auto w-full items-start justify-start whitespace-normal"
                  onClick={handleFork}
                  disabled={isWorking}
                >
                  <GitFork className="mt-0.5" />
                  <span className="text-start">
                    <span className="block">{t("page.fork", "Fork")}</span>
                    <span className="block text-xs font-normal text-muted-foreground">
                      {t(
                        "page.forkDescription",
                        "Keep the original and create a copy at this destination.",
                      )}
                    </span>
                  </span>
                </Button>
              </>
            }
          >
            {isWorking && <LoaderCircle className="animate-spin" />}
            {t("common.move", "Move")}
          </PopoverButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
