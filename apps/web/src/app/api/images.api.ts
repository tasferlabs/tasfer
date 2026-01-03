import { useMutation, type UseMutationOptions, useQuery, type UseQueryOptions } from "@tanstack/react-query";

const API_BASE = "/api";

export interface IImage {
  id: string;
  url: string;
  fileName: string;
  mimeType: string;
  size: number;
  createdAt?: string;
}

// Upload image
export async function uploadImage(file: File): Promise<IImage> {
  const formData = new FormData();
  formData.append("image", file);

  const response = await fetch(`${API_BASE}/images/upload`, {
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
  const response = await fetch(`${API_BASE}/images/${id}/info`);
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
  const response = await fetch(`${API_BASE}/images/${data.id}`, {
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
  return `${API_BASE}/images/${imageId}`;
}

