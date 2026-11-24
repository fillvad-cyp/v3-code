/**
 * Losslessly strips JPEG EXIF/GPS/XMP/IPTC/COM and PNG eXIf/tEXt/iTXt/zTXt/tIME chunks.
 * Bakes non-default JPEG EXIF Orientation (2..8) via canvas first so portrait photos stay upright.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

const PNG_STRIPPED_CHUNKS: ReadonlySet<string> = new Set(["eXIf", "tEXt", "iTXt", "zTXt", "tIME"]);

const MAX_SCRUBBABLE_BYTES = 32 * 1024 * 1024;

export interface ImageMetadataScrubResult {
  readonly bytes: Uint8Array;
  readonly stripped: boolean;
}

function concatChunks(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.byteLength;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * Reads the EXIF Orientation tag (0x0112) from a JPEG buffer if present.
 * Returns 1..8 when found, or 1 when absent/unreadable.
 */
export function readJpegExifOrientation(bytes: Uint8Array): number {
  if (bytes.byteLength < 16 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return 1;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;

  while (offset + 4 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) return 1;
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) return 1;
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0xda || marker === 0xd9) return 1;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.byteLength) return 1;
    const length = view.getUint16(offset, false);
    if (length < 2 || offset + length > bytes.byteLength) return 1;

    if (marker === 0xe1 && length >= 16) {
      const payloadStart = offset + 2;
      // Check "Exif\0\0" header.
      if (
        bytes[payloadStart] === 0x45 &&
        bytes[payloadStart + 1] === 0x78 &&
        bytes[payloadStart + 2] === 0x69 &&
        bytes[payloadStart + 3] === 0x66 &&
        bytes[payloadStart + 4] === 0x00 &&
        bytes[payloadStart + 5] === 0x00
      ) {
        const tiffStart = payloadStart + 6;
        if (tiffStart + 8 <= offset + length) {
          const littleEndian =
            bytes[tiffStart] === 0x49 && bytes[tiffStart + 1] === 0x49
              ? true
              : bytes[tiffStart] === 0x4d && bytes[tiffStart + 1] === 0x4d
                ? false
                : null;
          if (littleEndian !== null) {
            const firstIfdOffset = view.getUint32(tiffStart + 4, littleEndian);
            const ifdStart = tiffStart + firstIfdOffset;
            if (ifdStart + 2 <= offset + length) {
              const entryCount = view.getUint16(ifdStart, littleEndian);
              for (let i = 0; i < entryCount; i += 1) {
                const entryOffset = ifdStart + 2 + i * 12;
                if (entryOffset + 12 > offset + length) break;
                const tag = view.getUint16(entryOffset, littleEndian);
                if (tag === 0x0112) {
                  const orientation = view.getUint16(entryOffset + 8, littleEndian);
                  return orientation >= 1 && orientation <= 8 ? orientation : 1;
                }
              }
            }
          }
        }
      }
    }
    offset += length;
  }
  return 1;
}

function scrubJpegMetadata(bytes: Uint8Array): ImageMetadataScrubResult {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return { bytes, stripped: false };
  }

  const kept: Uint8Array[] = [bytes.subarray(0, 2)];
  let offset = 2;
  let stripped = false;

  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      return { bytes, stripped: false };
    }
    const markerStart = offset;
    while (offset < bytes.byteLength && bytes[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= bytes.byteLength) {
      return { bytes, stripped: false };
    }
    const marker = bytes[offset]!;
    offset += 1;

    if (marker === 0xda || marker === 0xd9) {
      kept.push(bytes.subarray(markerStart));
      return stripped ? { bytes: concatChunks(kept), stripped: true } : { bytes, stripped: false };
    }

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      kept.push(bytes.subarray(markerStart, offset));
      continue;
    }

    if (offset + 2 > bytes.byteLength) {
      return { bytes, stripped: false };
    }
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.byteLength) {
      return { bytes, stripped: false };
    }
    const segmentEnd = offset + length;

    // APP1 (EXIF/GPS/XMP), APP13 (IPTC/Photoshop), COM (comments).
    const shouldStrip = marker === 0xe1 || marker === 0xed || marker === 0xfe;
    if (shouldStrip) {
      stripped = true;
    } else {
      kept.push(bytes.subarray(markerStart, segmentEnd));
    }
    offset = segmentEnd;
  }

  return stripped ? { bytes: concatChunks(kept), stripped: true } : { bytes, stripped: false };
}

function scrubPngMetadata(bytes: Uint8Array): ImageMetadataScrubResult {
  if (bytes.byteLength < 8) {
    return { bytes, stripped: false };
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      return { bytes, stripped: false };
    }
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kept: Uint8Array[] = [bytes.subarray(0, 8)];
  let offset = 8;
  let stripped = false;

  while (offset + 12 <= bytes.byteLength) {
    const chunkLength = view.getUint32(offset, false);
    const totalChunkSize = 12 + chunkLength;
    if (chunkLength > 0x7fffffff || offset + totalChunkSize > bytes.byteLength) {
      return { bytes, stripped: false };
    }

    const chunkType = String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!,
    );
    if (PNG_STRIPPED_CHUNKS.has(chunkType)) {
      stripped = true;
    } else {
      kept.push(bytes.subarray(offset, offset + totalChunkSize));
    }

    offset += totalChunkSize;
    if (chunkType === "IEND") {
      break;
    }
  }

  return stripped ? { bytes: concatChunks(kept), stripped: true } : { bytes, stripped: false };
}

async function reorientAndStripJpegViaCanvas(file: File): Promise<File | null> {
  if (typeof createImageBitmap !== "function") return null;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    let blob: Blob | null = null;
    if (typeof OffscreenCanvas === "function") {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0);
      blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.94 });
    } else if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0);
      blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.94),
      );
    }
    if (!blob) return null;
    return new File([blob], file.name, { type: "image/jpeg", lastModified: 0 });
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

export function scrubImageMetadataBytes(
  bytes: Uint8Array,
  mimeType: string,
): ImageMetadataScrubResult {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/jpeg" || normalized === "image/jpg") {
    return scrubJpegMetadata(bytes);
  }
  if (normalized === "image/png") {
    return scrubPngMetadata(bytes);
  }
  return { bytes, stripped: false };
}

export async function scrubImageFileMetadata(
  file: File,
  enabled: boolean,
): Promise<{ readonly file: File; readonly stripped: boolean }> {
  if (!enabled || file.size === 0 || file.size > MAX_SCRUBBABLE_BYTES) {
    return { file, stripped: false };
  }
  const normalized = file.type.toLowerCase();
  if (normalized !== "image/jpeg" && normalized !== "image/jpg" && normalized !== "image/png") {
    return { file, stripped: false };
  }
  try {
    const raw = new Uint8Array(await file.arrayBuffer());
    if (normalized === "image/jpeg" || normalized === "image/jpg") {
      const orientation = readJpegExifOrientation(raw);
      if (orientation !== 1) {
        const reoriented = await reorientAndStripJpegViaCanvas(file);
        if (reoriented) {
          return { file: reoriented, stripped: true };
        }
        // Do not strip APP1 blindly if canvas cannot bake non-default rotation.
        return { file, stripped: false };
      }
    }
    const result = scrubImageMetadataBytes(raw, normalized);
    if (!result.stripped) {
      return { file, stripped: false };
    }
    const cleanBytes = new Uint8Array(result.bytes.byteLength);
    cleanBytes.set(result.bytes);
    return {
      file: new File([cleanBytes], file.name, {
        type: file.type,
        // Zero mtime so local capture timestamps are not leaked in attachment metadata.
        lastModified: 0,
      }),
      stripped: true,
    };
  } catch {
    return { file, stripped: false };
  }
}
