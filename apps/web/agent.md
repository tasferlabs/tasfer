# agent.md

This file provides guidance to new developers or agents when working with code in this repository.

## Project Overview

Cypher is a canvas-based markdown text editor that combines Google Docs-like editing experience with Notion-style block architecture. The editor renders text directly on an HTML5 canvas and provides real-time editing capabilities with cursor navigation and text selection.

> Everything in this document is work in progress, because the project is in active early development.

## Development Commands

```bash
# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## Key Data Structures

### Page Structure

```typescript
interface Page {
  title: string;
  blocks: Block[];
}

type Block = Heading | Paragraph;
```

### Editor State

The editor maintains immutable state containing:

- `page`: The document content as blocks
- `cursor`: Current cursor position (blockIndex, textIndex)
- `selection`: Text selection state with anchor/focus positions
- `viewport`: Canvas dimensions and scroll position
- `mode`: Editor mode (edit/select/readonly)

## Canvas Rendering System

The editor uses a custom canvas-based rendering system that:

- Renders text with proper font styling per block type
- Handles text wrapping based on viewport width
- Renders cursor with blinking animation
- Draws selection highlights with proper text measurement
- Maintains 60fps render loop using requestAnimationFrame

## Current Keyboard Support

- **Arrow Keys**: Navigate cursor position
- **Home/End**: Jump to document start/end
- **Escape**: Clear selection

Mouse events and text input are currently stubbed but the architecture supports them.

## File Organization

- `src/deserializer/`: Markdown parsing pipeline
- `src/editor/`: Core editor implementation
- `public/sample.md`: Sample markdown content for testing
- Root files: Standard Vite/TypeScript configuration

## Development Notes

- The editor loads `public/sample.md` by default for testing
- All state mutations return new immutable objects
- Canvas is sized to full viewport (100vw/100vh)
- TypeScript strict mode enabled with comprehensive type coverage
- No external dependencies beyond Vite and TypeScript
