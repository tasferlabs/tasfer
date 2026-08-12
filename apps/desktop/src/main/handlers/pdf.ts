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

      // No side margins: the export stylesheet pads the text column itself, so
      // a full-width image can bleed to the paper edge. A printer margin here
      // would crop the sheet before CSS ever sees it. Vertical margins stay —
      // they repeat per page, which body padding can't.
      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: "A4",
        margins: { top: 0.3, bottom: 0.3, left: 0, right: 0 },
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
