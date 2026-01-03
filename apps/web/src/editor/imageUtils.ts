import type { EditorState } from "./types";
import type { Block } from "../deserializer/loadPage";
import { uploadImage } from "../app/api/images.api";
import { invalidateBlockCache } from "./renderer";

/**
 * Update an image block with upload data
 */
export function updateImageBlock(
  state: EditorState,
  blockIndex: number,
  updates: {
    url?: string;
    alt?: string;
    width?: number;
    height?: number;
    uploadStatus?: "uploading" | "complete" | "error";
    file?: File;
  }
): EditorState {
  const block = state.document.page.blocks[blockIndex];
  
  if (block.type !== "image") {
    console.error("Attempted to update non-image block as image");
    return state;
  }

  const updatedBlock: Block = {
    ...block,
    ...updates,
  };

  // Invalidate cache for the updated block
  invalidateBlockCache(updatedBlock);

  const newBlocks = [...state.document.page.blocks];
  newBlocks[blockIndex] = updatedBlock;

  return {
    ...state,
    document: {
      ...state.document,
      page: { ...state.document.page, blocks: newBlocks },
    },
  };
}

/**
 * Handle image file upload for a block
 */
export async function handleImageUpload(
  state: EditorState,
  blockIndex: number,
  file: File,
  onStateUpdate: (state: EditorState) => void
): Promise<EditorState> {
  try {
    // Set uploading status
    let newState = updateImageBlock(state, blockIndex, {
      uploadStatus: "uploading",
      file,
    });
    onStateUpdate(newState);

    // Upload the image
    const imageData = await uploadImage(file);

    // Update with the uploaded URL
    newState = updateImageBlock(newState, blockIndex, {
      url: imageData.url,
      alt: imageData.fileName,
      uploadStatus: "complete",
      file: undefined,
    });
    onStateUpdate(newState);

    return newState;
  } catch (error) {
    console.error("Image upload failed:", error);
    
    // Set error status
    const errorState = updateImageBlock(state, blockIndex, {
      uploadStatus: "error",
    });
    onStateUpdate(errorState);
    
    return errorState;
  }
}

/**
 * Trigger file picker and upload image for a block
 */
export function openImagePicker(
  state: EditorState,
  blockIndex: number,
  onStateUpdate: (state: EditorState) => void
): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/jpeg,image/jpg,image/png,image/gif,image/webp,image/svg+xml";
  
  input.onchange = async (e) => {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    
    if (file) {
      await handleImageUpload(state, blockIndex, file, onStateUpdate);
    }
  };
  
  input.click();
}

/**
 * Delete an image block
 */
export function deleteImageBlock(
  state: EditorState,
  blockIndex: number
): EditorState {
  const newBlocks = [...state.document.page.blocks];
  newBlocks.splice(blockIndex, 1);

  // If we deleted the last block, add an empty paragraph
  if (newBlocks.length === 0) {
    newBlocks.push({
      id: `block-${Date.now()}`,
      type: "paragraph",
      content: [{ content: "", formats: undefined }],
    });
  }

  return {
    ...state,
    document: {
      ...state.document,
      page: { ...state.document.page, blocks: newBlocks },
    },
  };
}

