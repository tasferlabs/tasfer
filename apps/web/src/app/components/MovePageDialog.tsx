import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { movePageAcrossSpaces } from "@/lib/spaceMove";
import { type ISearchPage, useMovePage } from "../api/pages.api";
import { useSpaces } from "../contexts/SpaceContext";
import { useToast } from "./Toast";

interface MovePageDialogProps {
  pageId: string;
  sourceSpaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MovePageDialog({
  pageId,
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
  const [selectedParent, setSelectedParent] = useState<
    ISearchPage | null | undefined
  >(undefined);
  const [isMovingAcrossSpaces, setIsMovingAcrossSpaces] = useState(false);

  const { mutateAsync: movePage, isPending: isMovingWithinSpace } =
    useMovePage();
  const isMoving = isMovingWithinSpace || isMovingAcrossSpaces;

  useEffect(() => {
    if (!open) return;
    setSelectedSpaceId(sourceSpaceId);
    setSelectedParent(undefined);
  }, [open, sourceSpaceId]);

  function handleSpaceChange(spaceId: string) {
    setSelectedSpaceId(spaceId);
    setSelectedParent(undefined);
  }

  async function handleMove() {
    if (!selectedSpaceId || selectedParent === undefined || isMoving) return;

    try {
      if (selectedSpaceId === sourceSpaceId) {
        await movePage({
          id: pageId,
          parentId: selectedParent?.id ?? null,
        });
      } else {
        setIsMovingAcrossSpaces(true);
        const { idMap } = await movePageAcrossSpaces(
          pageId,
          selectedSpaceId,
          { targetParentId: selectedParent?.id ?? null },
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
              {t("page.parentPage", "Parent page")}
            </span>
            <PagePicker
              spaceId={selectedSpaceId}
              value={selectedParent}
              onChange={setSelectedParent}
              excludeId={
                selectedSpaceId === sourceSpaceId ? pageId : undefined
              }
              showNoneOption
              placeholder={t("page.selectParentPage", "Select a parent page")}
            />
          </label>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isMoving}
          >
            {t("common.cancel", "Cancel")}
          </Button>
          <Button
            onClick={handleMove}
            disabled={selectedParent === undefined || isMoving}
          >
            {isMoving && <LoaderCircle className="animate-spin" />}
            {t("common.move", "Move")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
