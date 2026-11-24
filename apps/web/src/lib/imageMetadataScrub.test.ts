import { describe, expect, it } from "vite-plus/test";
import {
  readJpegExifOrientation,
  scrubImageFileMetadata,
  scrubImageMetadataBytes,
} from "./imageMetadataScrub";

function u16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function makePngChunk(type: string, payload: number[]): number[] {
  const typeBytes = [...type].map((ch) => ch.charCodeAt(0));
  return [...u32(payload.length), ...typeBytes, ...payload, 0, 0, 0, 0];
}

describe("imageMetadataScrub", () => {
  it("strips JPEG APP1 EXIF/GPS, APP13 IPTC, and COM segments while preserving JFIF and SOS", () => {
    const jfifPayload = [0x4a, 0x46, 0x49, 0x46, 0x00];
    const exifPayload = [...new TextEncoder().encode("Exif\0\0GPS_LAT_37.7749")];
    const commentPayload = [...new TextEncoder().encode("iPhone 16 Pro Serial XYZ")];
    const sosAndPixels = [0xff, 0xda, 0x00, 0x08, 0x01, 0x02, 0x03, 0xff, 0xd9];

    const jpeg = new Uint8Array([
      0xff,
      0xd8,
      0xff,
      0xe0,
      ...u16(jfifPayload.length + 2),
      ...jfifPayload,
      0xff,
      0xe1,
      ...u16(exifPayload.length + 2),
      ...exifPayload,
      0xff,
      0xfe,
      ...u16(commentPayload.length + 2),
      ...commentPayload,
      ...sosAndPixels,
    ]);

    const result = scrubImageMetadataBytes(jpeg, "image/jpeg");
    expect(result.stripped).toBe(true);
    const decoded = new TextDecoder().decode(result.bytes);
    expect(decoded).toContain("JFIF");
    expect(decoded).not.toContain("GPS_LAT");
    expect(decoded).not.toContain("iPhone");
    expect(result.bytes.slice(-sosAndPixels.length)).toEqual(new Uint8Array(sosAndPixels));
  });

  it("strips PNG eXIf, tEXt, iTXt, and tIME chunks while preserving IHDR, IDAT, and IEND", () => {
    const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const ihdr = makePngChunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
    const exif = makePngChunk("eXIf", [...new TextEncoder().encode("GPS_SECRET")]);
    const text = makePngChunk("tEXt", [...new TextEncoder().encode("Author\0SecretUser")]);
    const time = makePngChunk("tIME", [0x07, 0xea, 11, 24, 17, 0, 0]);
    const idat = makePngChunk("IDAT", [1, 2, 3, 4]);
    const iend = makePngChunk("IEND", []);

    const png = new Uint8Array([
      ...pngSignature,
      ...ihdr,
      ...exif,
      ...text,
      ...time,
      ...idat,
      ...iend,
    ]);
    const result = scrubImageMetadataBytes(png, "image/png");
    expect(result.stripped).toBe(true);
    const decoded = new TextDecoder().decode(result.bytes);
    expect(decoded).toContain("IHDR");
    expect(decoded).toContain("IDAT");
    expect(decoded).toContain("IEND");
    expect(decoded).not.toContain("GPS_SECRET");
    expect(decoded).not.toContain("SecretUser");
  });

  it("leaves clean PNG without metadata untouched and zeros lastModified when stripping", async () => {
    const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const ihdr = makePngChunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
    const idat = makePngChunk("IDAT", [1, 2, 3]);
    const iend = makePngChunk("IEND", []);
    const cleanFile = new File(
      [new Uint8Array([...pngSignature, ...ihdr, ...idat, ...iend])],
      "clean.png",
      {
        type: "image/png",
        lastModified: 1700000000000,
      },
    );

    const unchanged = await scrubImageFileMetadata(cleanFile, true);
    expect(unchanged.stripped).toBe(false);
    expect(unchanged.file).toBe(cleanFile);

    const dirtyFile = new File(
      [
        new Uint8Array([
          ...pngSignature,
          ...ihdr,
          ...makePngChunk("tEXt", [...new TextEncoder().encode("Software\0Screenshot")]),
          ...idat,
          ...iend,
        ]),
      ],
      "shot.png",
      { type: "image/png", lastModified: 1700000000000 },
    );

    const disabled = await scrubImageFileMetadata(dirtyFile, false);
    expect(disabled.stripped).toBe(false);
    expect(disabled.file).toBe(dirtyFile);

    const scrubbed = await scrubImageFileMetadata(dirtyFile, true);
    expect(scrubbed.stripped).toBe(true);
    expect(scrubbed.file.lastModified).toBe(0);
    expect(scrubbed.file.size).toBeLessThan(dirtyFile.size);
  });

  it("reads JPEG EXIF Orientation tag so rotated phone photos are not corrupted", () => {
    // Little-endian TIFF header + 1 IFD entry: tag 0x0112 (Orientation), type SHORT(3), count 1, value 6 (90° CW)
    const exifBody = [
      0x45,
      0x78,
      0x69,
      0x66,
      0x00,
      0x00, // "Exif\0\0"
      0x49,
      0x49,
      0x2a,
      0x00,
      0x08,
      0x00,
      0x00,
      0x00, // II, 42, IFD offset 8
      0x01,
      0x00, // 1 entry
      0x12,
      0x01, // tag 0x0112
      0x03,
      0x00, // SHORT
      0x01,
      0x00,
      0x00,
      0x00, // count 1
      0x06,
      0x00,
      0x00,
      0x00, // value 6
    ];
    const rotatedJpeg = new Uint8Array([
      0xff,
      0xd8,
      0xff,
      0xe1,
      ...u16(exifBody.length + 2),
      ...exifBody,
      0xff,
      0xd9,
    ]);
    expect(readJpegExifOrientation(rotatedJpeg)).toBe(6);
  });
});
