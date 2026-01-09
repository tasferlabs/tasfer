# Accessibility Input Implementation

## Problem
Canvas-based editors are invisible to screen readers and accessibility tools. Users need to interact with actual DOM elements that assistive technologies can access.

## How Google Docs Does It
- Uses a **hidden contenteditable element** positioned at the cursor
- The contenteditable mirrors the document structure (headings, paragraphs, lists)
- Screen readers read from this hidden DOM while users see the canvas
- Browser selection API syncs with canvas cursor

## Current Approach

### What We Have
```typescript
// apps/web/src/editor/mount.ts (lines 86-114)
const hiddenInput = document.createElement("input");
hiddenInput.type = "text";
hiddenInput.style.opacity = "0";
// ... handles keyboard input via input events
```

**Limitations:**
- Single `<input>` element = no document structure for screen readers
- No ARIA announcements for changes
- Browser selection doesn't match canvas cursor
- Limited IME/composition support

## Implementation Plan

### Phase 1: ContentEditable Layer

Replace simple `<input>` with structured contenteditable:

```typescript
interface AccessibilityLayer {
  contentMirror: HTMLDivElement;      // contenteditable with document structure
  liveRegion: HTMLDivElement;         // ARIA announcements
}

function createAccessibilityLayer(): AccessibilityLayer {
  const contentMirror = document.createElement('div');
  contentMirror.contentEditable = 'true';
  contentMirror.setAttribute('role', 'textbox');
  contentMirror.setAttribute('aria-multiline', 'true');
  contentMirror.style.cssText = `
    position: absolute;
    opacity: 0;
    pointer-events: none;
  `;
  
  const liveRegion = document.createElement('div');
  liveRegion.setAttribute('role', 'status');
  liveRegion.setAttribute('aria-live', 'polite');
  liveRegion.style.position = 'absolute';
  liveRegion.style.left = '-10000px';
  
  return { contentMirror, liveRegion };
}
```

### Phase 2: Sync Canvas → DOM

Convert blocks to accessible HTML:

```typescript
function syncAccessibilityLayer(state: EditorState, layer: AccessibilityLayer) {
  // 1. Update content
  layer.contentMirror.innerHTML = blocksToHTML(state.document.page.blocks);
  
  // 2. Sync selection
  syncBrowserSelection(state, layer.contentMirror);
  
  // 3. Announce changes
  announceChange(state, layer.liveRegion);
}

function blocksToHTML(blocks: Block[]): string {
  return blocks.map(block => {
    switch (block.type) {
      case 'heading1': return `<h1>${segmentsToText(block.content)}</h1>`;
      case 'paragraph': return `<p>${segmentsToText(block.content)}</p>`;
      case 'bulletedList': return `<ul><li>${segmentsToText(block.content)}</li></ul>`;
      // ... etc
    }
  }).join('');
}
```

### Phase 3: Selection Sync

```typescript
function syncBrowserSelection(state: EditorState, mirror: HTMLElement) {
  const selection = window.getSelection();
  if (!selection || !state.document.cursor) return;
  
  // Find DOM node at cursor position
  const node = findDOMNodeAtPosition(state.document.cursor.position, mirror);
  
  const range = document.createRange();
  range.setStart(node.element, node.offset);
  range.collapse(true);
  
  selection.removeAllRanges();
  selection.addRange(range);
}
```

### Phase 4: Announcements

```typescript
function announceChange(state: EditorState, liveRegion: HTMLElement) {
  let message = '';
  
  // Format changes
  if (state.ui.activeFormatsMode.type === 'explicit') {
    const { bold, italic, code } = state.ui.activeFormatsMode.formats || {};
    if (bold) message += 'Bold. ';
    if (italic) message += 'Italic. ';
    if (code) message += 'Code. ';
  }
  
  // Block type changes
  const cursor = state.document.cursor;
  if (cursor) {
    const block = state.document.page.blocks[cursor.position.blockIndex];
    if (block.type === 'heading1') message += 'Heading 1. ';
    if (block.type === 'heading2') message += 'Heading 2. ';
    // ... etc
  }
  
  liveRegion.textContent = message;
}
```

## Integration Points

### 1. Mount (`mount.ts`)
```typescript
const accessibilityLayer = createAccessibilityLayer();
container.appendChild(accessibilityLayer.contentMirror);
container.appendChild(accessibilityLayer.liveRegion);

// Replace hiddenInput event listeners with contentMirror listeners
accessibilityLayer.contentMirror.addEventListener('beforeinput', ...);
accessibilityLayer.contentMirror.addEventListener('compositionstart', ...);
```

### 2. Editor (`editor.ts`)
```typescript
// Add sync call after state changes
function setState(newState: EditorState) {
  state = newState;
  syncAccessibilityLayer(state, accessibilityLayer);
  scheduleRender();
}
```

### 3. Event Handlers (`events.ts`)
- No changes needed - keep existing input handling logic
- Events from contenteditable flow through same handlers

## Testing Checklist

- [ ] VoiceOver (macOS/iOS) - Read structure, navigate, edit
- [ ] TalkBack (Android) - Full editing experience
- [ ] NVDA/JAWS (Windows) - Desktop screen readers
- [ ] Keyboard-only navigation
- [ ] Voice typing (iOS dictation, Google Voice)
- [ ] IME input (Chinese, Japanese, Korean)

## Benefits

✅ Screen readers can read document structure  
✅ Voice typing works natively  
✅ Better IME/composition support  
✅ Native browser selection  
✅ Accessibility compliance (WCAG 2.1)  
✅ No performance impact (hidden DOM is lightweight)

## References

- [Google Docs Accessibility](https://www.google.com/accessibility/)
- [ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)
- [ContentEditable Best Practices](https://developer.mozilla.org/en-US/docs/Web/HTML/Global_attributes/contenteditable)

