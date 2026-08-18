import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const STORAGE_BUCKETS = {
  taxpayerEvidence: "taxpayer-evidence",
  taxpayerImports: "taxpayer-imports",
  purchaseInvoiceImports: "purchase-invoice-imports",
} as const;

type StorageBucket = typeof STORAGE_BUCKETS[keyof typeof STORAGE_BUCKETS];

export function getStorageRoot() {
  return path.resolve(/*turbopackIgnore: true*/ process.env.APP_STORAGE_ROOT?.trim() || path.join(process.cwd(), "storage"));
}

function getBucketRoot(bucket: string) {
  if (!Object.values(STORAGE_BUCKETS).includes(bucket as StorageBucket)) {
    throw new Error(`Storage bucket không hợp lệ: ${bucket}`);
  }
  return path.join(/*turbopackIgnore: true*/ getStorageRoot(), bucket);
}

function resolveStoragePath(bucket: string, storagePath: string) {
  if (!storagePath || storagePath.includes("\0") || storagePath.includes("\\") || path.posix.isAbsolute(storagePath)) {
    throw new Error("Storage path không hợp lệ.");
  }

  const bucketRoot = getBucketRoot(bucket);
  const normalized = path.posix.normalize(storagePath);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Storage path vượt ra ngoài bucket.");
  }

  const absolutePath = path.resolve(bucketRoot, ...normalized.split("/"));
  const bucketPrefix = `${bucketRoot}${path.sep}`;
  if (absolutePath !== bucketRoot && !absolutePath.startsWith(bucketPrefix)) {
    throw new Error("Storage path vượt ra ngoài bucket.");
  }
  return absolutePath;
}

async function ensureParent(filePath: string) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o770 });
}

export async function putStorageObject(
  bucket: string,
  storagePath: string,
  body: Uint8Array,
  options: { upsert?: boolean } = {},
) {
  const filePath = resolveStoragePath(bucket, storagePath);
  await ensureParent(filePath);
  await writeFile(filePath, body, { flag: options.upsert ? "w" : "wx", mode: 0o660 });
  return storagePath;
}

export async function readStorageObject(bucket: string, storagePath: string) {
  return readFile(resolveStoragePath(bucket, storagePath));
}

export async function deleteStorageObject(bucket: string, storagePath: string) {
  const filePath = resolveStoragePath(bucket, storagePath);
  try {
    await rm(filePath, { force: true });
    return true;
  } catch (error) {
    console.error("local storage delete failed", { bucket, storagePath, error });
    return false;
  }
}

export function getStorageObjectPath(bucket: string, storagePath: string) {
  return resolveStoragePath(bucket, storagePath);
}

export function createLocalStorageClient() {
  return {
    from(bucket: string) {
      return {
        async upload(storagePath: string, body: Uint8Array, options?: { upsert?: boolean }) {
          try {
            const pathValue = await putStorageObject(bucket, storagePath, body, options);
            return { data: { path: pathValue }, error: null };
          } catch (error) {
            return { data: null, error: error instanceof Error ? error : new Error(String(error)) };
          }
        },
        async download(storagePath: string) {
          try {
            const body = await readStorageObject(bucket, storagePath);
            return { data: new Blob([body]), error: null };
          } catch (error) {
            return { data: null, error: error instanceof Error ? error : new Error(String(error)) };
          }
        },
        async remove(storagePaths: string[]) {
          const results = await Promise.all(storagePaths.map((storagePath) => deleteStorageObject(bucket, storagePath)));
          return results.every(Boolean)
            ? { data: storagePaths.map((name) => ({ name })), error: null }
            : { data: null, error: new Error("Không thể xóa một hoặc nhiều file Storage.") };
        },
      };
    },
  };
}
