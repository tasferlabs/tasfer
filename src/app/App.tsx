import React from "react";
import { useEditor } from "./useEditor";

const EditorCanvas: React.FC = () => {
  const canvasRef = useEditor("/sample.md");

  return <canvas ref={canvasRef} className="w-screen h-screen cursor-text" />;
};

const App: React.FC = () => {
  return <EditorCanvas />;
};

export default App;
