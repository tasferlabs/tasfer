import { getPlatform } from "./platform";

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.split(",")[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Download/share a file. On native platforms (iOS/Android), opens the native
 * share sheet so the user can choose where to save. On web, triggers a
 * standard browser download.
 */
export async function downloadFile(
  blob: Blob,
  fileName: string,
  mimeType: string,
): Promise<void> {
  const platform = getPlatform();

  if (platform === "ios" && window.IOSBridge?.shareFile) {
    const base64 = await blobToBase64(blob);
    await window.IOSBridge.shareFile(base64, fileName, mimeType);
    return;
  }

  if (platform === "android" && window.AndroidBridge?.shareFile) {
    const base64 = await blobToBase64(blob);
    window.AndroidBridge.shareFile(base64, fileName, mimeType);
    return;
  }

  // Web fallback: standard anchor download
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
