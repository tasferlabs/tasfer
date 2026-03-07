import { useEffect, useCallback, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { X, Maximize2, GripHorizontal, Clock, Calendar } from "lucide-react";
import { DateTime } from "luxon";
import { useTranslation } from "react-i18next";
import { Drawer, DrawerContent } from "@/components/ui/drawer";
import { formatDurationLabel, DURATION_OPTIONS } from "@/lib/utils";
import DateTimePicker from "@/components/datetimepickers/DateTimePicker";
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxList,
  ComboboxItem,
} from "@/components/ui/combobox";
import type { Block } from "@/deserializer/loadPage";
import { extractTitleFromBlocks } from "@/editor/sync/char-runs";
import {
  useGetPage,
  useUpdatePage,
  updatePage as updatePageApi,
  type HLC,
} from "../../api/pages.api";
import { useDebouncedSave } from "../../hooks/useDebouncedSave";
import useResponsive from "../../hooks/useResponsive";
import { MountedEditor } from "../../MountedEditor";
import style from "./CalendarPage.module.css";

const DEFAULT_WIDTH = 400;
const DEFAULT_HEIGHT = 420;
const MIN_WIDTH = 300;
const MIN_HEIGHT = 300;
const GAP = 8;

function computePosition(anchor: DOMRect | null, width: number, height: number) {
  if (!anchor) {
    return {
      top: Math.max(GAP, (window.innerHeight - height) / 2),
      left: Math.max(GAP, (window.innerWidth - width) / 2),
    };
  }

  let left: number;
  let top: number;

  // Try right of event
  if (anchor.right + GAP + width < window.innerWidth - GAP) {
    left = anchor.right + GAP;
  }
  // Try left of event
  else if (anchor.left - GAP - width > GAP) {
    left = anchor.left - GAP - width;
  }
  // Fallback: align to right edge
  else {
    left = window.innerWidth - width - GAP;
  }

  // Vertically center relative to anchor, clamped to viewport
  top = anchor.top + anchor.height / 2 - height / 2;
  top = Math.max(GAP, Math.min(top, window.innerHeight - height - GAP));

  return { top, left };
}

export function EventPreview({
  pageId,
  anchor,
  onClose,
}: {
  pageId: string | null;
  anchor: DOMRect | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const isMobile = useResponsive("(max-width: 768px)");
  const queryClient = useQueryClient();
  const popoverRef = useRef<HTMLDivElement>(null);

  const [size, setSize] = useState({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; startTop: number; startLeft: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(null);

  // Reset size and position when opening a new preview
  useEffect(() => {
    if (pageId) {
      setSize({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
      setPos(null); // will be computed from anchor
    }
  }, [pageId]);

  // Compute initial position from anchor (only when pos is null)
  const computedPos = useMemo(
    () => computePosition(anchor, size.width, size.height),
    [anchor, size],
  );
  const currentPos = pos ?? computedPos;

  // Drag + resize pointer handling (single effect)
  useEffect(() => {
    function handlePointerMove(e: PointerEvent) {
      if (dragRef.current) {
        const dx = e.clientX - dragRef.current.startX;
        const dy = e.clientY - dragRef.current.startY;
        setPos({
          top: Math.max(GAP, dragRef.current.startTop + dy),
          left: Math.max(GAP, dragRef.current.startLeft + dx),
        });
      }
      if (resizeRef.current) {
        const { startX, startY, startW, startH } = resizeRef.current;
        setSize({
          width: Math.max(MIN_WIDTH, startW + (e.clientX - startX)),
          height: Math.max(MIN_HEIGHT, startH + (e.clientY - startY)),
        });
      }
    }
    function handlePointerUp() {
      dragRef.current = null;
      resizeRef.current = null;
    }
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, []);

  const handleDragPointerDown = useCallback((e: React.PointerEvent) => {
    // Don't drag if clicking a button or link inside the header
    if ((e.target as HTMLElement).closest("a, button")) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startTop: currentPos.top,
      startLeft: currentPos.left,
    };
  }, [currentPos]);

  const handleResizePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    // Pin position so top-left stays fixed during resize
    setPos(currentPos);
    resizeRef.current = { startX: e.clientX, startY: e.clientY, startW: size.width, startH: size.height };
  }, [size, currentPos]);

  const { data: previewPage, isLoading } = useGetPage(pageId || undefined);

  const { mutate: updatePage } = useUpdatePage({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["calendar-pages"] });
      queryClient.invalidateQueries({ queryKey: ["page", pageId] });
    },
  });


  // Close on click outside
  useEffect(() => {
    if (!pageId) return;
    function handlePointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (
        popoverRef.current &&
        !popoverRef.current.contains(target) &&
        !(target instanceof Element && target.closest("[data-radix-popper-content-wrapper], [role=\"dialog\"]"))
      ) {
        onClose();
      }
    }
    // Delay listener to avoid closing on the same click that opened it
    const timer = setTimeout(() => {
      window.addEventListener("pointerdown", handlePointerDown);
    }, 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [pageId, onClose]);

  // Close on Escape
  useEffect(() => {
    if (!pageId) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pageId, onClose]);

  // Save edits from preview editor
  const handleSave = useCallback(
    async (data: { pageId: string; snapshot: Block[]; clock: HLC | null }) => {
      const title = extractTitleFromBlocks(data.snapshot);
      await updatePageApi({
        id: data.pageId,
        snapshot: data.snapshot,
        snapshotClock: data.clock,
        title,
      });
      queryClient.invalidateQueries({ queryKey: ["calendar-pages"] });
      queryClient.invalidateQueries({ queryKey: ["pages"] });
    },
    [queryClient],
  );

  const { save: debouncedSave, flush } = useDebouncedSave(handleSave, 1000);

  const handleContentChange = useCallback(
    (snapshot: Block[], clock: HLC | null) => {
      if (!pageId) return;
      debouncedSave({ pageId, snapshot, clock });
    },
    [pageId, debouncedSave],
  );

  const handleClose = useCallback(() => {
    flush();
    onClose();
  }, [flush, onClose]);

  const handleScheduleChange = useCallback(
    (scheduledAt: number, duration: number | null) => {
      if (!pageId) return;
      updatePage({ id: pageId, scheduledAt, duration });
    },
    [pageId, updatePage],
  );

  const tz = DateTime.local().zoneName;
  const dateValue = previewPage?.scheduledAt
    ? DateTime.fromMillis(previewPage.scheduledAt, { zone: tz }).toISO()
    : null;
  const currentDuration = previewPage?.duration ?? 60;

  const durationLabels = useMemo(
    () => DURATION_OPTIONS.map((d) => formatDurationLabel(d, t)),
    [t],
  );

  const handleDateChange = (value: string | null) => {
    if (!value || !previewPage?.scheduledAt) return;
    const ms = DateTime.fromISO(value, { zone: tz }).toMillis();
    if (!isNaN(ms)) handleScheduleChange(ms, previewPage.duration);
  };

  const handleDurationChange = (val: string) => {
    const idx = durationLabels.indexOf(val);
    if (idx !== -1 && previewPage?.scheduledAt) {
      handleScheduleChange(previewPage.scheduledAt, DURATION_OPTIONS[idx]);
    }
  };

  const editorPadding = useMemo(
    () => ({
      paddingTop: 8,
      paddingBottom: 16,
      paddingLeft: 12,
      paddingRight: 12,
    }),
    [],
  );

  const editor =
    isLoading ? (
      <div className={style.previewLoading}>{t("Loading...")}</div>
    ) : previewPage?.snapshot && pageId ? (
      <MountedEditor
        snapshot={previewPage.snapshot}
        pageId={pageId}
        snapshotClock={previewPage.snapshotClock}
        onContentChange={handleContentChange}
        className="h-full"
        autoFocus
        padding={editorPadding}
      />
    ) : null;

  if (!pageId) return null;

  if (isMobile) {
    return (
      <Drawer
        open={pageId !== null}
        onOpenChange={(open) => {
          if (!open) handleClose();
        }}
        modal={false}
      >
        <DrawerContent className="h-[90vh] flex flex-col p-0">
          <div className={style.previewPopoverHeader}>
            <Link to={`/page/${pageId}`} className={style.previewOpenLink}>
              <Maximize2 size={14} />
              {t("Open page")}
            </Link>
            <button className={style.previewCloseBtn} onClick={handleClose}>
              <X size={16} />
            </button>
          </div>
          <div className={style.previewRow}>
            <Calendar size={14} className={style.previewRowIcon} />
            <DateTimePicker
              type="datetime"
              value={dateValue}
              onChange={handleDateChange}
              timezone={tz}
              size="small"
            />
          </div>
          <div className={style.previewRow}>
            <Clock size={14} className={style.previewRowIcon} />
            <Combobox
              items={durationLabels}
              value={formatDurationLabel(currentDuration, t)}
              onValueChange={(val) => {
                if (val != null) handleDurationChange(val);
              }}
            >
              <ComboboxInput
                placeholder={formatDurationLabel(currentDuration, t)}
              />
              <ComboboxContent>
                <ComboboxList>
                  {(item) => (
                    <ComboboxItem key={item} value={item}>
                      {item}
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
          </div>
          <div className="flex-1 overflow-hidden border-t border-border">
            {editor}
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <div
      ref={popoverRef}
      className={style.previewPopover}
      style={{ top: currentPos.top, left: currentPos.left, width: size.width, height: size.height }}
    >
      <div
        className={style.previewPopoverHeader}
        onPointerDown={handleDragPointerDown}
      >
        <GripHorizontal size={16} className={style.previewGripIcon} />
        <button className={style.previewCloseBtn} onClick={handleClose}>
          <X size={16} />
        </button>
      </div>
      <div className={style.previewRow}>
        <Calendar size={14} className={style.previewRowIcon} />
        <DateTimePicker
          type="datetime"
          value={dateValue}
          onChange={handleDateChange}
          timezone={tz}
          size="small"
        />
      </div>
      <div className={style.previewRow}>
        <Clock size={14} className={style.previewRowIcon} />
        <Combobox
          items={durationLabels}
          value={formatDurationLabel(currentDuration, t)}
          onValueChange={(val) => {
            if (val != null) handleDurationChange(val);
          }}
        >
          <ComboboxInput
            placeholder={formatDurationLabel(currentDuration, t)}
          />
          <ComboboxContent>
            <ComboboxList>
              {(item) => (
                <ComboboxItem key={item} value={item}>
                  {item}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </div>
      <div className={style.previewRow}>
        <Maximize2 size={14} className={style.previewRowIcon} />
        <Link to={`/page/${pageId}`} className={style.previewOpenLink}>
          {t("Open page")}
        </Link>
      </div>
      <div className={style.previewEditorArea}>{editor}</div>
      <div
        className={style.previewResizeHandle}
        onPointerDown={handleResizePointerDown}
      />
    </div>
  );
}
