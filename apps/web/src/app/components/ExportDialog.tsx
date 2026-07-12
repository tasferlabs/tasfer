import { useState } from "react";
import JSZip from "jszip";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ArrowLeft, Download, FileCode, FileType, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePageSettings } from "../contexts/PageSettingsContext";
import useResponsive from "../hooks/useResponsive";
import { serializeToMarkdown } from "@cypherkit/editor";
import { serializeToHTML } from "@cypherkit/editor";
import { collectAssetRefs } from "@cypherkit/editor";
import { extractTitleFromBlocks } from "@cypherkit/editor/internal";
import { imageCache } from "@cypherkit/editor/internal";
import { renderToSVG } from "@cypherkit/editor/math";
import { getPlatform } from "@/platform";
import { getTexFontUrl } from "@/fonts";
import { getPage } from "../api/pages.api";
import type { PageMetadata } from "@cypherkit/editor";
import { downloadFile } from "@/downloadFile";
import { getBridge } from "@/platform/bridge";
import { appDataSchema } from "@/appDataSchema";

interface ElectronWindow {
  cypher?: { invoke(channel: string, ...args: unknown[]): Promise<unknown> };
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

/** Guess file extension from mime type */
function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
  };
  return map[mime] || "bin";
}

/** Convert a cached HTMLImageElement to a Blob by drawing to an offscreen canvas */
function imageElementToBlob(img: HTMLImageElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      resolve(null);
      return;
    }
    ctx.drawImage(img, 0, 0);
    canvas.toBlob((blob) => resolve(blob), "image/png");
  });
}

/** Fetch an image blob, resolving asset hashes via the platform and falling back to imageCache. */
async function fetchImageBlob(url: string): Promise<Blob | null> {
  const isAlreadyUrl =
    url.startsWith("blob:") ||
    url.startsWith("data:") ||
    url.startsWith("http://") ||
    url.startsWith("https://");

  // Resolve asset hashes (e.g. "assets/<hash>.png") to a real URL the same way the renderer does
  let resolvedUrl = url;
  if (!isAlreadyUrl) {
    try {
      resolvedUrl = await getPlatform().assets.getUrl(url);
    } catch {
      // ignore — fall through to fetch attempt / cache fallback
    }
  }

  try {
    const response = await fetch(resolvedUrl);
    if (response.ok) {
      const blob = await response.blob();
      if (blob.size > 0) return blob;
    }
  } catch {
    // fetch failed — fall through to imageCache
  }

  // Fallback: extract from the renderer's in-memory image cache (handles revoked blob URLs)
  const cached = imageCache.get(url);
  if (cached && cached.complete && cached.naturalWidth > 0) {
    return imageElementToBlob(cached);
  }

  return null;
}

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ExportDialog({ open, onOpenChange }: ExportDialogProps) {
  const { t } = useTranslation();
  const { currentBlocks, pageId } = usePageSettings();
  const isMobile = useResponsive("(max-width: 768px)");
  const [isExporting, setIsExporting] = useState(false);
  // Mobile only: the self-contained export HTML held for on-screen preview
  // before the user commits to generating/sharing the PDF. Null = show the
  // format picker; a string = show the preview step. The PDF is generated from
  // this exact HTML, so previewing it is a faithful preview of the export.
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);

  const handleOpenChange = (next: boolean) => {
    if (!next) setPreviewHtml(null);
    onOpenChange(next);
  };

  const getBaseName = () => {
    const title = extractTitleFromBlocks(currentBlocks) || "document";
    const sanitized = title
      .replace(/[<>:"/\\|?*]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);
    return sanitized || "document";
  };

  const downloadTextFile = async (
    content: string,
    extension: string,
    mimeType: string,
  ) => {
    const blob = new Blob([content], { type: mimeType });
    await downloadFile(blob, `${getBaseName()}.${extension}`, mimeType);
    handleOpenChange(false);
  };

  const fetchMetadata = async (): Promise<PageMetadata | undefined> => {
    if (!pageId) return undefined;
    try {
      const pageData = await getPage(pageId);
      const meta: PageMetadata = {};
      if (pageData.task) meta.task = true;
      if (pageData.scheduledAt) meta.scheduledAt = pageData.scheduledAt;
      if (pageData.duration != null) meta.duration = pageData.duration;
      if (pageData.allDay != null) meta.allDay = pageData.allDay;
      if (pageData.color) meta.color = pageData.color;
      return Object.keys(meta).length > 0 ? meta : undefined;
    } catch {
      return undefined;
    }
  };

  const blobToDataUrl = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(blob);
    });

  // Rendered math is `<text>` bound to `CypherTeX_<Variant>` families that the
  // app loads at runtime but the isolated print/PDF context never does. Inline
  // the WOFF2 faces the document actually uses as data-URL `@font-face`s so the
  // exported HTML is self-contained (same reason images become data URLs).
  const buildMathFontFaceCss = async (
    renderedHtml: string,
  ): Promise<string> => {
    const variants = new Set<string>();
    for (const m of renderedHtml.matchAll(
      /font-family="CypherTeX_([\w-]+)"/g,
    )) {
      variants.add(m[1]);
    }
    if (variants.size === 0) return "";

    const faces = await Promise.all(
      [...variants].map(async (variant) => {
        const url = getTexFontUrl(variant);
        if (!url) return null;
        try {
          const response = await fetch(url);
          if (!response.ok) return null;
          const dataUrl = await blobToDataUrl(await response.blob());
          return `@font-face{font-family:'CypherTeX_${variant}';src:url(${dataUrl}) format('woff2');font-display:block;}`;
        } catch {
          return null;
        }
      }),
    );
    return faces.filter((f): f is string => f !== null).join("\n");
  };

  const buildExportHtml = async (): Promise<string> => {
    // Resolve image URLs to data URLs so they survive across windows / native renderers
    const imageUrlMap = new Map<string, string>();
    for (const url of collectAssetRefs(currentBlocks, appDataSchema)) {
      const blob = await fetchImageBlob(url);
      if (blob) {
        try {
          imageUrlMap.set(url, await blobToDataUrl(blob));
        } catch {
          // ignore — the image just won't render
        }
      }
    }

    const title = getBaseName();
    const renderReplacement = (
      type: string,
      source: string,
      displayMode: boolean,
    ) => {
      if (type !== "math") throw new Error(`Unsupported replacement: ${type}`);
      return renderToSVG(source, displayMode);
    };
    const html = serializeToHTML(currentBlocks, {
      title,
      imageUrlMap,
      schema: appDataSchema,
      renderReplacement,
    });

    // If the document has math, re-emit with the used faces inlined so the
    // formulas render in the print context. No math → the first pass is final.
    const extraCss = await buildMathFontFaceCss(html);
    if (!extraCss) return html;
    return serializeToHTML(currentBlocks, {
      title,
      imageUrlMap,
      extraCss,
      schema: appDataSchema,
      renderReplacement,
    });
  };

  const printViaWindow = async (html: string) => {
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.open();
    win.document.write(html);
    win.document.close();

    const triggerPrint = async () => {
      const imgs = Array.from(win.document.images);
      await Promise.all(
        imgs.map((img) =>
          img.complete
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                img.onload = () => resolve();
                img.onerror = () => resolve();
              }),
        ),
      );
      win.focus();
      win.print();
    };

    if (win.document.readyState === "complete") await triggerPrint();
    else win.addEventListener("load", () => void triggerPrint());
  };

  // Turn the export HTML into a PDF and hand it off (native share sheet, Electron
  // download, or the web print dialog). Shared by the desktop one-tap flow and
  // the mobile preview's confirm button.
  // Turn the export HTML into a PDF and hand it off (native share sheet, Electron
  // download, or the web print dialog). Always called from the preview's confirm
  // button, so `html` is already built — the web fallback's `window.open` runs
  // synchronously inside that click and isn't treated as a blocked popup.
  const deliverPdf = async (html: string) => {
    const baseName = getBaseName();

    // Native (iOS/Android): render PDF in the WebView, then share via system sheet
    const bridge = getBridge();
    if (bridge?.files.htmlToPdf) {
      const pdfBase64 = await bridge.files.htmlToPdf(html);
      if (pdfBase64) {
        const blob = base64ToBlob(pdfBase64, "application/pdf");
        await downloadFile(blob, `${baseName}.pdf`, "application/pdf");
        return;
      }
      // fall through to print-window fallback if native returned null
    }

    // Electron: silent printToPDF in main process, then download via existing flow
    const electron = (window as unknown as ElectronWindow).cypher;
    if (electron?.invoke) {
      const buf = (await electron.invoke("pdf:generate", html)) as ArrayBuffer;
      const blob = new Blob([buf], { type: "application/pdf" });
      await downloadFile(blob, `${baseName}.pdf`, "application/pdf");
      return;
    }

    // Web fallback: open new window and trigger system print dialog
    await printViaWindow(html);
  };

  // Step 1 (drawer on mobile, dialog on desktop): build the self-contained HTML
  // and switch to the preview so the user sees the document before committing.
  const handlePreviewPdf = async () => {
    setIsExporting(true);
    try {
      setPreviewHtml(await buildExportHtml());
    } finally {
      setIsExporting(false);
    }
  };

  // Step 2: the user has seen the preview and confirmed the download.
  const handleConfirmPdf = async () => {
    if (!previewHtml) return;
    setIsExporting(true);
    try {
      await deliverPdf(previewHtml);
      handleOpenChange(false);
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportMarkdown = async () => {
    const metadata = await fetchMetadata();

    // All asset references owned by the blocks (handles blob:, /api/images/, etc.)
    const assetUrls = collectAssetRefs(currentBlocks, appDataSchema);

    // No images → plain .md download
    if (assetUrls.length === 0) {
      downloadTextFile(
        serializeToMarkdown(currentBlocks, metadata, {
          schema: appDataSchema,
        }),
        "md",
        "text/markdown",
      );
      return;
    }

    // Has images → create ZIP
    setIsExporting(true);
    try {
      const zip = new JSZip();
      const baseName = getBaseName();
      // Map: original URL → ZIP filename (e.g. "image_0.png")
      const urlToFileName = new Map<string, string>();
      let imgIndex = 0;

      for (const url of assetUrls) {
        const blob = await fetchImageBlob(url);
        if (blob) {
          const ext = extFromMime(blob.type);
          const fileName = `image_${imgIndex}.${ext}`;
          urlToFileName.set(url, fileName);
          zip.file(`images/${fileName}`, blob);
          imgIndex++;
        }
      }

      // Asset urls become bundle-relative paths via the serializer itself —
      // no post-hoc rewriting of the markdown string.
      const markdown = serializeToMarkdown(currentBlocks, metadata, {
        schema: appDataSchema,
        mapAssetUrl: (url) => {
          const fileName = urlToFileName.get(url);
          return fileName ? `./images/${fileName}` : url;
        },
      });

      zip.file(`${baseName}.md`, markdown);

      const blob = await zip.generateAsync({ type: "blob" });
      await downloadFile(blob, `${baseName}.zip`, "application/zip");
      handleOpenChange(false);
    } finally {
      setIsExporting(false);
    }
  };

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={handleOpenChange}>
        <DrawerContent>
          {previewHtml !== null ? (
            // Preview step: show the document as it will be exported, then let
            // the user confirm the download or go back to the format picker.
            <div className="flex flex-1 flex-col min-h-0">
              <DrawerHeader>
                <DrawerTitle>
                  {t("export.previewPdf", "Preview PDF")}
                </DrawerTitle>
              </DrawerHeader>
              <div className="flex-1 min-h-0 px-4">
                <iframe
                  title={t("export.previewPdf", "Preview PDF")}
                  srcDoc={previewHtml}
                  sandbox=""
                  className="h-full min-h-[50vh] w-full rounded-lg border border-border bg-white"
                />
              </div>
              <div className="flex gap-2 p-4">
                <Button
                  variant="outline"
                  className="flex-1 gap-2"
                  onClick={() => setPreviewHtml(null)}
                  disabled={isExporting}
                >
                  <ArrowLeft className="h-4 w-4" />
                  {t("common.back", "Back")}
                </Button>
                <Button
                  className="flex-1 gap-2"
                  onClick={handleConfirmPdf}
                  disabled={isExporting}
                >
                  {isExporting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  {t("export.downloadPdf", "Download PDF")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="mx-auto w-full max-w-sm pb-6">
              <DrawerHeader>
                <DrawerTitle>
                  {t("export.document", "Export document")}
                </DrawerTitle>
              </DrawerHeader>
              <div className="px-4 space-y-2">
                <Button
                  variant="outline"
                  className="w-full justify-start gap-3 h-auto py-3"
                  onClick={handlePreviewPdf}
                  disabled={isExporting}
                >
                  {isExporting ? (
                    <Loader2 className="h-5 w-5 text-muted-foreground animate-spin" />
                  ) : (
                    <FileType className="h-5 w-5 text-muted-foreground" />
                  )}
                  <div className="flex flex-col items-start">
                    <span className="font-medium">
                      {t("export.pdf", "PDF")}
                    </span>
                    <span className="text-xs text-muted-foreground">.pdf</span>
                  </div>
                </Button>
                <Button
                  variant="outline"
                  className="w-full justify-start gap-3 h-auto py-3"
                  onClick={handleExportMarkdown}
                  disabled={isExporting}
                >
                  {isExporting ? (
                    <Loader2 className="h-5 w-5 text-muted-foreground animate-spin" />
                  ) : (
                    <FileCode className="h-5 w-5 text-muted-foreground" />
                  )}
                  <div className="flex flex-col items-start">
                    <span className="font-medium">
                      {isExporting
                        ? t("export.exporting", "Exporting...")
                        : t("common.markdown", "Markdown")}
                    </span>
                    <span className="text-xs text-muted-foreground">.md</span>
                  </div>
                </Button>
              </div>
            </div>
          )}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {previewHtml !== null ? (
        // Preview step: show the document as it will be exported, then let the
        // user confirm the download or go back to the format picker.
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("export.previewPdf", "Preview PDF")}</DialogTitle>
          </DialogHeader>
          <iframe
            title={t("export.previewPdf", "Preview PDF")}
            srcDoc={previewHtml}
            sandbox=""
            className="h-[65vh] w-full rounded-lg border border-border bg-white"
          />
          <DialogFooter>
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => setPreviewHtml(null)}
              disabled={isExporting}
            >
              <ArrowLeft className="h-4 w-4" />
              {t("common.back", "Back")}
            </Button>
            <Button
              className="gap-2"
              onClick={handleConfirmPdf}
              disabled={isExporting}
            >
              {isExporting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {t("export.downloadPdf", "Download PDF")}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("export.document", "Export document")}</DialogTitle>
            <DialogDescription>
              {t(
                "export.chooseFormat",
                "Choose a format to export your document",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-3 gap-3">
            <button
              onClick={handlePreviewPdf}
              disabled={isExporting}
              className="flex flex-col items-center justify-center p-4 rounded-lg border-2 border-border hover:border-primary hover:bg-accent transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isExporting ? (
                <Loader2 className="h-8 w-8 mb-2 text-muted-foreground animate-spin" />
              ) : (
                <FileType className="h-8 w-8 mb-2 text-muted-foreground" />
              )}
              <span className="font-medium">{t("export.pdf", "PDF")}</span>
              <span className="text-xs text-muted-foreground">.pdf</span>
            </button>
            <button
              onClick={handleExportMarkdown}
              disabled={isExporting}
              className="flex flex-col items-center justify-center p-4 rounded-lg border-2 border-border hover:border-primary hover:bg-accent transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isExporting ? (
                <Loader2 className="h-8 w-8 mb-2 text-muted-foreground animate-spin" />
              ) : (
                <FileCode className="h-8 w-8 mb-2 text-muted-foreground" />
              )}
              <span className="font-medium">
                {isExporting
                  ? t("export.exporting", "Exporting...")
                  : t("common.markdown", "Markdown")}
              </span>
              <span className="text-xs text-muted-foreground">.md</span>
            </button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
