
export {};

declare global {
  interface Window {
    // Native -> Web (Injected by Native) & Web -> Native (Called by Web)
    IOSBridge?: {
      postMessage: (message: {
        action: string;
        text?: string;
        canUndo?: boolean;
        canRedo?: boolean;
      }) => void;
      // Editor methods (assigned by Web)
      undo?: () => void;
      redo?: () => void;
      setBlockType?: (type: string) => void;
      focus?: () => void;
    };
    
    AndroidBridge?: {
      // Web -> Native (Provided by native Android)
      copy: (text: string) => void;
      cut: (text: string) => void;
      paste: () => string;
      updateUndoRedoState?: (canUndo: boolean, canRedo: boolean) => void;
      // Editor methods (assigned by Web to allow native to call back)
      undo?: () => void;
      redo?: () => void;
      setBlockType?: (type: string) => void;
      focus?: () => void;
    };
  }
}
