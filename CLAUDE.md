# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cypher is a canvas-based markdown text editor that combines Google Docs-like editing experience with Notion-style block architecture. The editor renders text directly on an HTML5 canvas and provides real-time editing capabilities with cursor navigation and text selection.

## Development Commands

```bash
# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## Architecture Overview

The application follows a functional, immutable state architecture with three main layers:

### 1. Deserializer (`src/deserializer/`)
- **Tokenizer** (`tokenizer.ts`): Converts raw markdown into tokens (HEADING_1, HEADING_2, HEADING_3, NEWLINE, etc.)
- **Parser** (`parser.ts`): Transforms tokens into an Abstract Syntax Tree (AST) with typed blocks
- **LoadPage** (`loadPage.ts`): Main entry point that orchestrates tokenization and parsing

### 2. Editor (`src/editor/`)
- **Index** (`index.ts`): Main editor factory with event loop and render cycle
- **State** (`state.ts`): Immutable state management for cursor, selection, and viewport
- **Events** (`events.ts`): Event handling system for keyboard navigation (mouse events stubbed)
- **Renderer** (`renderer.ts`): Canvas rendering engine with text wrapping and visual feedback
- **Types** (`types.ts`): Complete type definitions for all editor components
- **Styles** (`styles.ts`): Styling configuration for different block types
- **Utils** (`utils.ts`): Canvas utilities and helper functions

### 3. Main Application (`src/main.ts`)
Entry point that:
1. Fetches sample.md content
2. Parses it through the deserializer
3. Creates and initializes the editor
4. Starts the render loop

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