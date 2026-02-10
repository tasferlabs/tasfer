import fs from "fs/promises";
import path from "path";

const isDev = true;
const devPath = path.resolve("../../cdn");

export async function writeFile(
  buffer: Buffer,
  filePath: string,
  options?: {
    mimetype?: string;
    bucketName?: string;
  }
): Promise<void> {
  const bucketName = options?.bucketName || "images";

  if (isDev) {
    const absoluteFilePath = path.join(devPath, bucketName, filePath);
    const dirname = path.dirname(absoluteFilePath);

    // Ensure directory exists
    await fs.mkdir(dirname, { recursive: true });

    // Create the file
    await fs.writeFile(absoluteFilePath, buffer);

    return;
  }

  // TODO: Add cloud storage support for production
  throw new Error("Cloud storage not implemented yet");
}

export async function readFile(
  filePath: string,
  options?: { bucketName?: string }
): Promise<Buffer | null> {
  const bucketName = options?.bucketName || "images";

  if (isDev) {
    const absoluteFilePath = path.join(devPath, bucketName, filePath);

    try {
      await fs.access(absoluteFilePath);
    } catch (error) {
      return null;
    }

    const file = await fs.readFile(absoluteFilePath);
    return file;
  }

  // TODO: Add cloud storage support for production
  throw new Error("Cloud storage not implemented yet");
}

export async function deleteFile(
  filePath: string,
  options?: { bucketName?: string }
): Promise<void> {
  const bucketName = options?.bucketName || "images";

  if (isDev) {
    const absoluteFilePath = path.join(devPath, bucketName, filePath);
    await fs.rm(absoluteFilePath);
    return;
  }

  // TODO: Add cloud storage support for production
  throw new Error("Cloud storage not implemented yet");
}
