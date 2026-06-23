import type { Block } from "../serlization/loadPage";

type VisibleBlock = Block & { originalIndex: number };

/**
 * Prefix-sum index for block flow heights.
 *
 * Entries start with cheap estimates and are replaced with exact node-layout
 * heights as blocks enter the viewport. This lets initial rendering and caret
 * restoration jump directly to a distant block without laying out every block
 * before it.
 */
export class BlockHeightIndex {
  private blocks: VisibleBlock[] = [];
  private heights: number[] = [];
  private exact: boolean[] = [];
  private tree: number[] = [0];
  private visibleIndexByOriginal = new Map<number, number>();
  private visibleIndexById = new Map<string, number>();

  rebuild(
    blocks: VisibleBlock[],
    estimateHeight: (block: VisibleBlock, visibleIndex: number) => number,
  ): void {
    this.replace(blocks, estimateHeight);
  }

  /**
   * Update for a new immutable page while preserving learned heights by stable
   * block ID. An unchanged block keeps its exact status; a changed block keeps
   * the previous height as a close provisional value and is re-measured when it
   * enters the viewport. New blocks use the node-owned estimate.
   */
  reconcile(
    blocks: VisibleBlock[],
    estimateHeight: (block: VisibleBlock, visibleIndex: number) => number,
  ): void {
    const previous = new Map<
      string,
      { block: VisibleBlock; height: number; exact: boolean }
    >();
    for (let i = 0; i < this.blocks.length; i++) {
      previous.set(this.blocks[i].id, {
        block: this.blocks[i],
        height: this.heights[i],
        exact: this.exact[i],
      });
    }

    this.replace(blocks, (block, index) => {
      const old = previous.get(block.id);
      return old?.height ?? estimateHeight(block, index);
    });

    for (let i = 0; i < blocks.length; i++) {
      const old = previous.get(blocks[i].id);
      this.exact[i] =
        !!old &&
        old.block === blocks[i] &&
        old.exact &&
        blocks[i].cachedLayout !== undefined;
    }
  }

  private replace(
    blocks: VisibleBlock[],
    initialHeight: (block: VisibleBlock, visibleIndex: number) => number,
  ): void {
    this.blocks = blocks;
    this.heights = new Array(blocks.length);
    this.exact = new Array(blocks.length).fill(false);
    this.tree = new Array(blocks.length + 1).fill(0);
    this.visibleIndexByOriginal.clear();
    this.visibleIndexById.clear();

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const height = initialHeight(block, i);
      this.heights[i] = height;
      this.visibleIndexByOriginal.set(block.originalIndex, i);
      this.visibleIndexById.set(block.id, i);
      const treeIndex = i + 1;
      this.tree[treeIndex] += height;
      const parent = treeIndex + (treeIndex & -treeIndex);
      if (parent < this.tree.length) {
        this.tree[parent] += this.tree[treeIndex];
      }
    }
  }

  get length(): number {
    return this.blocks.length;
  }

  totalHeight(): number {
    return this.prefixHeight(this.blocks.length);
  }

  heightAt(visibleIndex: number): number {
    return this.heights[visibleIndex] ?? 0;
  }

  isExact(visibleIndex: number): boolean {
    return this.exact[visibleIndex] ?? false;
  }

  setExactHeight(visibleIndex: number, height: number): number {
    if (
      visibleIndex < 0 ||
      visibleIndex >= this.heights.length ||
      !Number.isFinite(height) ||
      height < 0
    ) {
      return 0;
    }
    const previous = this.heights[visibleIndex];
    const delta = height - previous;
    this.heights[visibleIndex] = height;
    this.exact[visibleIndex] = true;
    if (delta !== 0) this.add(visibleIndex, delta);
    return delta;
  }

  /** Height of all blocks before `visibleIndex`. */
  offsetOfVisibleIndex(visibleIndex: number): number {
    return this.prefixHeight(
      Math.max(0, Math.min(visibleIndex, this.blocks.length)),
    );
  }

  offsetOfOriginalIndex(originalIndex: number): number | null {
    const visibleIndex = this.visibleIndexByOriginal.get(originalIndex);
    return visibleIndex === undefined
      ? null
      : this.offsetOfVisibleIndex(visibleIndex);
  }

  offsetOfBlockId(blockId: string): number | null {
    const visibleIndex = this.visibleIndexById.get(blockId);
    return visibleIndex === undefined
      ? null
      : this.offsetOfVisibleIndex(visibleIndex);
  }

  visibleIndexOfOriginal(originalIndex: number): number | null {
    return this.visibleIndexByOriginal.get(originalIndex) ?? null;
  }

  visibleIndexOfBlockId(blockId: string): number | null {
    return this.visibleIndexById.get(blockId) ?? null;
  }

  /**
   * Find the block containing a document-flow Y coordinate. Returns the final
   * block for coordinates beyond the estimated document end.
   */
  visibleIndexAtOffset(offset: number): number {
    if (this.blocks.length === 0) return 0;
    const target = Math.max(0, offset);
    let index = 0;
    let bit = highestPowerOfTwoAtMost(this.blocks.length);
    let sum = 0;

    while (bit !== 0) {
      const next = index + bit;
      if (next <= this.blocks.length && sum + this.tree[next] <= target) {
        index = next;
        sum += this.tree[next];
      }
      bit >>= 1;
    }

    return Math.min(index, this.blocks.length - 1);
  }

  private prefixHeight(count: number): number {
    let sum = 0;
    for (let i = count; i > 0; i -= i & -i) sum += this.tree[i];
    return sum;
  }

  private add(index: number, delta: number): void {
    for (let i = index + 1; i < this.tree.length; i += i & -i) {
      this.tree[i] += delta;
    }
  }
}

function highestPowerOfTwoAtMost(value: number): number {
  let power = 1;
  while (power * 2 <= value) power *= 2;
  return power;
}
