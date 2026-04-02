/**
 * Media helpers — file upload and download for NewioApp.
 */
import type { NewioClient } from '../core/client.js';
import type { Attachment } from '../core/types.js';

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
};

/**
 * Upload local files to S3 via presigned URLs.
 * Returns attachment metadata for inclusion in a message.
 */
export async function uploadFiles(client: NewioClient, filePaths: readonly string[]): Promise<Attachment[]> {
  const fsPromises = await import('fs/promises');
  const pathMod = await import('path');

  const attachments: Attachment[] = [];
  for (const filePath of filePaths) {
    const fileName = pathMod.basename(filePath);
    const ext = pathMod.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
    const data = await fsPromises.readFile(filePath);
    const { s3Key } = await client.uploadFile({
      fileName,
      contentType,
      body: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    });
    attachments.push({
      type: contentType.startsWith('image/') ? 'image' : 'file',
      s3Key,
      fileName,
      contentType,
      size: data.byteLength,
    });
  }
  return attachments;
}

/**
 * Download a message attachment to a local directory.
 * Files are organized as: `<downloadDir>/<conversationId>/<timestamp>-<fileName>`
 * Returns the local file path.
 */
export async function downloadAttachment(
  client: NewioClient,
  downloadDir: string,
  conversationId: string,
  s3Key: string,
  fileName: string,
): Promise<string> {
  const fsPromises = await import('fs/promises');
  const pathMod = await import('path');

  const dir = pathMod.join(downloadDir, conversationId);
  await fsPromises.mkdir(dir, { recursive: true });

  const { url } = await client.getDownloadUrl({ conversationId, s3Key });
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Download failed: ${String(resp.status)}`);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  const filePath = pathMod.join(dir, `${Date.now()}-${fileName}`);
  await fsPromises.writeFile(filePath, buffer);
  return filePath;
}
