export const TAXPAYER_EVIDENCE_BUCKET = "taxpayer-evidence";
export const TAXPAYER_EVIDENCE_MAX_BYTES = 4 * 1024 * 1024;

export const TAXPAYER_EVIDENCE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export type TaxpayerEvidenceMimeType = typeof TAXPAYER_EVIDENCE_MIME_TYPES[number];

const EXTENSION_MIME_TYPES: Record<string, TaxpayerEvidenceMimeType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export function resolveTaxpayerEvidenceMimeType(fileName: string, declaredType: string) {
  const normalizedType = declaredType.trim().toLowerCase();
  if (normalizedType) {
    if (normalizedType === "image/jpg") return "image/jpeg" as const;
    return (TAXPAYER_EVIDENCE_MIME_TYPES as readonly string[]).includes(normalizedType)
      ? normalizedType as TaxpayerEvidenceMimeType
      : null;
  }

  const extension = fileName.trim().toLowerCase().split(".").pop() ?? "";
  return EXTENSION_MIME_TYPES[extension] ?? null;
}

function hasAsciiSignature(bytes: Uint8Array, offset: number, value: string) {
  if (bytes.length < offset + value.length) return false;
  return [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
}

export function detectTaxpayerEvidenceMimeType(bytes: Uint8Array): TaxpayerEvidenceMimeType | null {
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  if (bytes.length >= 12 && hasAsciiSignature(bytes, 0, "RIFF") && hasAsciiSignature(bytes, 8, "WEBP")) {
    return "image/webp";
  }

  return null;
}

export function getTaxpayerEvidenceStoragePath(taxCode: string, mimeType: TaxpayerEvidenceMimeType) {
  const extension = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
  return `${taxCode}/${crypto.randomUUID()}.${extension}`;
}

export function sanitizeTaxpayerEvidenceFileName(fileName: string) {
  const sanitized = fileName
    .trim()
    .replace(/[\\/\u0000-\u001f]/g, "_")
    .slice(0, 255);
  return sanitized || "bang-chung-thue";
}
