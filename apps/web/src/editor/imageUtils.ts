import type { EditorState } from "./types";
import type { Block } from "../deserializer/loadPage";
import { uploadImage } from "../app/api/images.api";
import { invalidateBlockCache } from "./renderer";

/**
 * Update an image cover block with new data
 */
export function updateImageCoverBlock(
  state: EditorState,
  blockIndex: number,
  updates: {
    url?: string;
    alt?: string;
  },
  uploadStatus?: "uploading" | "complete" | "error"
): EditorState {
  const block = state.document.page.blocks[blockIndex];
  
  if (block.type !== "imageCover") {
    console.error("Attempted to update non-image-cover block as image cover");
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

  // Update UI state with upload status if provided
  let newUIState = state.ui;
  if (uploadStatus !== undefined && state.ui.activeMenu.type === 'imageUpload' && state.ui.activeMenu.blockIndex === blockIndex) {
    newUIState = {
      ...state.ui,
      activeMenu: {
        ...state.ui.activeMenu,
        uploadStatus,
      },
    };
  }

  return {
    ...state,
    ui: newUIState,
    document: {
      ...state.document,
      page: { ...state.document.page, blocks: newBlocks },
    },
  };
}

/**
 * Handle image file upload for an image cover block
 */
export async function handleImageCoverUpload(
  state: EditorState,
  blockIndex: number,
  file: File,
  onStateUpdate: (state: EditorState) => void
): Promise<EditorState> {
  try {
    // Set uploading status in UI
    let newState = updateImageCoverBlock(state, blockIndex, {}, "uploading");
    onStateUpdate(newState);

    // Upload the image
    const imageData = await uploadImage(file);

    // Update with the uploaded URL
    newState = updateImageCoverBlock(newState, blockIndex, {
      url: imageData.url,
      alt: imageData.fileName,
    }, "complete");
    onStateUpdate(newState);

    return newState;
  } catch (error) {
    console.error("Image upload failed:", error);
    
    // Set error status
    const errorState = updateImageCoverBlock(state, blockIndex, {}, "error");
    onStateUpdate(errorState);
    
    return errorState;
  }
}

/**
 * Trigger file picker and upload image for an image cover block
 */
export function openImageCoverPicker(
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
      await handleImageCoverUpload(state, blockIndex, file, onStateUpdate);
    }
  };
  
  input.click();
}

/**
 * Delete an image cover block
 */
export function deleteImageCoverBlock(
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

