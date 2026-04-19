/**
 * Media helpers — file upload and download for NewioApp.
 */
import type { NewioClient } from '../core/client.js';
import type { Attachment, AttachmentType, ImageMetadata } from '../core/types.js';

/** Cached lazy import for sharp (optional peer dependency). */
let sharpLoaded = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sharpDefault: ((input: Buffer) => any) | null = null;

async function getSharp(): Promise<typeof sharpDefault> {
  if (!sharpLoaded) {
    sharpLoaded = true;
    try {
      const mod = await import('sharp');
      sharpDefault = mod.default as typeof sharpDefault;
    } catch {
      sharpDefault = null;
    }
  }
  return sharpDefault;
}

/** Cached lazy import for blurhash (optional peer dependency). */
let blurhashLoaded = false;
let blurhashEncode:
  | ((pixels: Uint8ClampedArray, width: number, height: number, xComp: number, yComp: number) => string)
  | null = null;

async function getBlurhash(): Promise<typeof blurhashEncode> {
  if (!blurhashLoaded) {
    blurhashLoaded = true;
    try {
      const mod = await import('blurhash');
      blurhashEncode = mod.encode;
    } catch {
      blurhashEncode = null;
    }
  }
  return blurhashEncode;
}

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

/** Max dimension for the downscaled image used for blurhash encoding. */
const BLURHASH_MAX_DIM = 32;

/** Detect image by file magic bytes (first 4–12 bytes). */
function isImageBuffer(buffer: Buffer): boolean {
  if (buffer.length < 4) {
    return false;
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return true;
  }
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return true;
  }
  // GIF: 47 49 46 38
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return true;
  }
  // WebP: RIFF....WEBP
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return true;
  }
  return false;
}

/**
 * Extract image dimensions and blurhash using sharp (optional peer dependency).
 * Returns null if sharp/blurhash are not installed or the buffer is not a decodable image.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
async function getImageMetadata(data: Buffer): Promise<ImageMetadata | null> {
  const sharp = await getSharp();
  const encode = await getBlurhash();
  if (!sharp || !encode) {
    return null;
  }
  try {
    const image = sharp(data);
    const { width, height } = await image.metadata();
    if (!width || !height) {
      return null;
    }
    const scale = Math.min(1, BLURHASH_MAX_DIM / Math.max(width, height));
    const sw = Math.max(1, Math.round(width * scale));
    const sh = Math.max(1, Math.round(height * scale));
    const { data: pixels, info } = await image
      .resize(sw, sh, { fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const blurhash = encode(
      new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength),
      info.width,
      info.height,
      4,
      3,
    );
    return { width, height, blurhash };
  } catch {
    return null;
  }
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */

/**
 * Upload local files to S3 via presigned URLs.
 * Returns attachment metadata for inclusion in a message.
 *
 * For images (detected via magic bytes), extracts dimensions and blurhash.
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

    // Detect image by magic bytes, then extract metadata
    let attachmentType: AttachmentType = 'file';
    let imageMetadata: ImageMetadata | undefined;
    if (isImageBuffer(data)) {
      const meta = await getImageMetadata(data);
      if (meta) {
        attachmentType = 'image';
        imageMetadata = meta;
      }
    }

    const { s3Key } = await client.uploadFile({
      fileName,
      contentType,
      body: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    });
    attachments.push({
      type: attachmentType,
      s3Key,
      fileName,
      contentType,
      size: data.byteLength,
      ...(imageMetadata ? { imageMetadata } : {}),
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
