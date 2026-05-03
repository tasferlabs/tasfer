/**
 * PDF generation handler — renders HTML to a PDF buffer using an
 * offscreen BrowserWindow + webContents.printToPDF().
 */

import { ipcMain, BrowserWindow } from "electron";

export function registerPdfHandlers() {
  ipcMain.handle("pdf:generate", async (_, html: string) => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        offscreen: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    try {
      const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
      await win.loadURL(dataUrl);
      // Give layout/images a tick to settle (data URLs decode synchronously, but
      // SVG and font measurement still need a frame).
      await new Promise((resolve) => setTimeout(resolve, 100));

      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: "A4",
        margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
      });

      // Return ArrayBuffer for IPC transport
      return pdf.buffer.slice(
        pdf.byteOffset,
        pdf.byteOffset + pdf.byteLength,
      );
    } finally {
      win.destroy();
    }
  });
}
