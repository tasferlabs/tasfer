/**
 * Shared image-asset resolution for the export flows. Image blocks reference
 * assets by raw content hash (see images.api.ts); exports resolve those to
 * bytes the same way the renderer does.
 */

import { getPlatform } from "@/platform";
import { imageCache } from "@tasfer/editor/internal";

/** Guess file extension from mime type */
export function extFromMime(mime: string): string {
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
export async function fetchImageBlob(url: string): Promise<Blob | null> {
  const isAlreadyUrl =
    url.startsWith("blob:") ||
    url.startsWith("data:") ||
    url.startsWith("http://") ||
    url.startsWith("https://");

  // Resolve asset hashes to a real URL the same way the renderer does
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
