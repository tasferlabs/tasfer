import express from "express";
import cors from "cors";
import pagesRouter from "./routes/pages.js";
import imagesRouter from "./routes/images.js";
import versionRouter from "./routes/version.js";

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Routes
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/api/pages", pagesRouter);
app.use("/api/images", imagesRouter);
app.use("/api/version", versionRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, error: "Not found" });
});

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ success: false, error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`📄 Pages API: http://localhost:${PORT}/api/pages`);
  console.log(`🖼️  Images API: http://localhost:${PORT}/api/images`);
});

