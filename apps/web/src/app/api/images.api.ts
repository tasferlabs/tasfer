import { useMutation, type UseMutationOptions, useQuery, type UseQueryOptions } from "@tanstack/react-query";
import imageCompression from "browser-image-compression";
import { authFetch, API_BASE, getAuthenticatedImageUrl } from "./client";

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

// Upload image
export async function uploadImage(file: File): Promise<IImage> {
  const compressed = await compressFile(file);

  const formData = new FormData();
  formData.append("image", compressed);

  const response = await authFetch(`${API_BASE}/images/upload`, {
    method: "POST",
    body: formData,
  });

  const result = await response.json();

  if (!result.success) {
    throw new Error(result.error || "Failed to upload image");
  }

  return result.data;
}

export function useUploadImage<TContext = unknown>(
  options?: UseMutationOptions<IImage, Error, File, TContext>
) {
  return useMutation({
    mutationFn: uploadImage,
    ...options,
  });
}

// Get image info
export async function getImageInfo(id: string): Promise<IImage> {
  const response = await authFetch(`${API_BASE}/images/${id}/info`);
  const data = await response.json();

  if (!data.success) {
    throw new Error(data.error || "Failed to fetch image info");
  }

  return data.data;
}

export function useGetImageInfo(id?: string, options?: UseQueryOptions<IImage, Error, IImage, any>) {
  return useQuery({
    queryKey: ["image-info", id],
    queryFn: () => getImageInfo(id!),
    enabled: !!id,
    ...options,
  });
}

// Delete image
interface IDeleteImage {
  id: string;
}

export async function deleteImage(data: IDeleteImage): Promise<void> {
  const response = await authFetch(`${API_BASE}/images/${data.id}`, {
    method: "DELETE",
  });

  const result = await response.json();

  if (!result.success) {
    throw new Error(result.error || "Failed to delete image");
  }
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
export function getImageUrl(imageId: string): string {
  return getAuthenticatedImageUrl(`${API_BASE}/images/${imageId}`);
}
