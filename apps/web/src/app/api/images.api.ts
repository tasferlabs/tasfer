import { useMutation, type UseMutationOptions } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import imageCompression from "browser-image-compression";
import { getPlatform } from "@/platform";
import type { Asset } from "@/platform";

export interface IImage {
  id: string;
  url: string;
  fileName: string;
  mimeType: string;
  size: number;
  createdAt?: string;
}

const COMPRESSION_OPTIONS = {
  maxSizeMB: 2,
  maxWidthOrHeight: 2000,
  useWebWorker: true,
  fileType: "image/webp" as const,
};

async function compressFile(file: File): Promise<File> {
  // Skip SVGs and small files (< 500KB)
  if (file.type === "image/svg+xml" || file.size < 500 * 1024) {
    return file;
  }

  try {
    return await imageCompression(file, COMPRESSION_OPTIONS);
  } catch {
    // Fall back to original file if compression fails
    return file;
  }
}

function assetToImage(asset: Asset): IImage {
  return {
    id: asset.hash,
    url: asset.hash,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    size: asset.size,
  };
}

// Upload image
export async function uploadImage(file: File): Promise<IImage> {
  const compressed = await compressFile(file);
  const platform = getPlatform();
  const asset = await platform.assets.store(compressed);
  return assetToImage(asset);
}

export function useUploadImage<TContext = unknown>(
  options?: UseMutationOptions<IImage, Error, File, TContext>
) {
  return useMutation({
    mutationFn: uploadImage,
    ...options,
  });
}

// Delete image
interface IDeleteImage {
  id: string;
}

export async function deleteImage(data: IDeleteImage): Promise<void> {
  const platform = getPlatform();
  return platform.assets.delete(data.id);
}

export function useDeleteImage<TContext = unknown>(
  options?: UseMutationOptions<void, Error, IDeleteImage, TContext>
) {
  return useMutation({
    mutationFn: deleteImage,
    ...options,
  });
}

// Get image URL helper
export async function getImageUrl(imageId: string): Promise<string> {
  const platform = getPlatform();
  return platform.assets.getUrl(imageId);
}

// React hook for resolving an asset hash to a blob URL
export function useAssetUrl(hash: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!hash) {
      setUrl(null);
      return;
    }

    let cancelled = false;
    getImageUrl(hash).then(
      (resolved) => { if (!cancelled) setUrl(resolved); },
      () => { if (!cancelled) setUrl(null); },
    );
    return () => { cancelled = true; };
  }, [hash]);

  return url;
}
