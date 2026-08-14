import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/app-auth";
import { INVOICE_MODEL_ID, extractInvoiceFromFile, getInvoiceMaxUploadBytes, getInvoiceMonthlyScanLimit, normalizeExtractedInvoice, resolveInvoiceFileDescriptor, sha256Hex } from "@/lib/invoice-extraction";
import { INVOICE_SELECT } from "@/lib/invoice-db";
import { attachInvoiceTaxpayers, ensureInvoiceTaxpayer } from "@/lib/invoice-taxpayer";
import { createAdminClient } from "@/lib/supabase/admin";
import { invokeTaxpayerRefresh } from "@/lib/xinvoice-worker";
import type { InvoiceRecord } from "@/lib/invoice-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function readQuota(data: unknown) {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") return null;
  const value = row as { allowed?: boolean; used_count?: number; monthly_limit?: number };
  if (typeof value.allowed !== "boolean") return null;
  return {
    allowed: value.allowed,
    used: Number(value.used_count ?? 0),
    limit: Number(value.monthly_limit ?? 200),
  };
}

export async function POST(request: Request) {
  const session = await authenticateRequest(request);
  if (!session) return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Không đọc được file tải lên." }, { status: 400 });
  }

  const fileValue = formData.get("file");
  if (!(fileValue instanceof File)) {
    return NextResponse.json({ error: "Vui lòng chọn một file hóa đơn." }, { status: 400 });
  }
  if (fileValue.size <= 0) {
    return NextResponse.json({ error: "File hóa đơn đang rỗng." }, { status: 400 });
  }

  const maxBytes = getInvoiceMaxUploadBytes();
  if (fileValue.size > maxBytes) {
    return NextResponse.json({ error: "File vượt quá giới hạn 4 MiB (4.194.304 bytes)." }, { status: 413 });
  }

  const descriptor = resolveInvoiceFileDescriptor(fileValue.name, fileValue.type);
  if (!descriptor) {
    return NextResponse.json({ error: "Chỉ chấp nhận file PDF, XML, JPG/JPEG, PNG, WEBP hoặc GIF." }, { status: 415 });
  }

  const buffer = Buffer.from(await fileValue.arrayBuffer());
  if (buffer.length > maxBytes) {
    return NextResponse.json({ error: "File vượt quá giới hạn 4 MiB (4.194.304 bytes)." }, { status: 413 });
  }
  const sourceFileSha256 = sha256Hex(buffer);

  const supabase = createAdminClient();
  const { data: quotaData, error: quotaError } = await supabase.rpc("consume_invoice_scan_quota", {
    p_limit: getInvoiceMonthlyScanLimit(),
  });
  if (quotaError) {
    console.error("invoice quota query failed", quotaError);
    return NextResponse.json({ error: "Không thể kiểm tra hạn mức quét hóa đơn. Hãy chạy migration invoices trên Supabase." }, { status: 500 });
  }
  const quota = readQuota(quotaData);
  if (!quota) {
    return NextResponse.json({ error: "Cục Thuế trả về dữ liệu hạn mức không hợp lệ." }, { status: 500 });
  }
  if (!quota.allowed) {
    return NextResponse.json({
      error: "Đã dùng hết hạn mức quét hóa đơn " + quota.limit + " hóa đơn trong tháng này.",
      usage: { used: quota.used, limit: quota.limit, remaining: 0 },
    }, { status: 429 });
  }

  let extractionResult: Awaited<ReturnType<typeof extractInvoiceFromFile>>;
  try {
    extractionResult = await extractInvoiceFromFile({
      buffer,
      fileName: fileValue.name,
      descriptor,
    });
  } catch (error) {
    console.error("invoice AI extraction failed", error);
    const message = error instanceof Error ? error.message : "Không thể trích xuất thông tin hóa đơn.";
    return NextResponse.json({ error: message }, { status: message.includes("AI_GATEWAY_API_KEY") ? 503 : 502 });
  }

  const extracted = normalizeExtractedInvoice(extractionResult.extraction, sourceFileSha256);
  if (!extracted.invoice_number || !extracted.invoice_number_key) {
    return NextResponse.json({ error: "Không đọc được số hóa đơn. Vui lòng kiểm tra file rõ nét hơn rồi thử lại." }, { status: 422 });
  }

  const { data: existing, error: existingError } = await supabase
    .from("invoices")
    .select("id, invoice_number")
    .eq("invoice_number_key", extracted.invoice_number_key)
    .maybeSingle<{ id: string; invoice_number: string }>();
  if (existingError) {
    console.error("invoice duplicate check failed", existingError);
    return NextResponse.json({ error: "Không thể kiểm tra hóa đơn đã tồn tại." }, { status: 500 });
  }
  if (existing) {
    return NextResponse.json({
      error: "Hóa đơn cùng định danh (MST, mẫu số/ký hiệu và số hóa đơn) đã tồn tại trong hệ thống.",
      invoiceExists: true,
      invoiceNumber: existing.invoice_number,
      usage: { used: quota.used, limit: quota.limit, remaining: Math.max(0, quota.limit - quota.used) },
    }, { status: 409 });
  }

  const fileName = fileValue.name.replace(/[\\\\/]/g, "_").slice(0, 255);
  const { data: invoice, error: insertError } = await supabase
    .from("invoices")
    .insert({
      ...extracted,
      source_file_name: fileName,
      source_file_mime_type: descriptor.mediaType,
      source_file_size: buffer.length,
      source_file_sha256: sourceFileSha256,
      extracted_model: INVOICE_MODEL_ID,
      extracted_payload: {
        extraction: extractionResult.extraction,
        usage: extractionResult.usage,
      },
      verification_status: "unverified",
      imported_by: session.username,
    })
    .select(INVOICE_SELECT)
    .single();

  if (insertError || !invoice) {
    if (insertError?.code === "23505") {
      return NextResponse.json({ error: "Hóa đơn cùng định danh đã tồn tại trong hệ thống.", invoiceExists: true, invoiceNumber: extracted.invoice_number }, { status: 409 });
    }
    console.error("invoice insert failed", insertError);
    return NextResponse.json({ error: "Không thể lưu thông tin hóa đơn vào cơ sở dữ liệu." }, { status: 500 });
  }

  let invoiceWithTaxpayer = invoice as unknown as InvoiceRecord;
  let taxpayerSync: {
    status: "not_applicable" | "existing" | "added" | "pending" | "error";
    message?: string;
  } = { status: "not_applicable" };

  const normalizedSellerTaxCode = extracted.seller_tax_code;
  if (normalizedSellerTaxCode) {
    try {
      const ensureResult = await ensureInvoiceTaxpayer(supabase, {
        sellerTaxCode: normalizedSellerTaxCode,
        sellerName: extracted.seller_name,
        invoiceDate: extracted.invoice_date,
        sourceFileName: fileName,
      });

      if (!ensureResult.taxCode) {
        taxpayerSync = {
          status: "error",
          message: "MST bên bán không đúng định dạng nên chưa được đưa vào danh mục MST.",
        };
      } else {
        taxpayerSync = { status: ensureResult.created ? "added" : "existing" };

        if (ensureResult.created) {
          try {
            const workerPayload = await invokeTaxpayerRefresh(ensureResult.taxCode);
            const workerResult = workerPayload.results?.find((result) => result.tax_code === ensureResult.taxCode);
            if (workerPayload.processed === 0 || !workerResult) {
              taxpayerSync = {
                status: "pending",
                message: "MST mới đã được đưa vào hàng đợi và đang chờ worker cập nhật.",
              };
            } else if (!workerResult.ok) {
              taxpayerSync = {
                status: "error",
                message: workerResult.error ?? "Worker chưa cập nhật được MST mới.",
              };
            }
          } catch (workerError) {
            console.error("invoice taxpayer worker invocation failed", workerError);
            taxpayerSync = {
              status: "pending",
              message: "MST mới đã được lưu nhưng chưa gọi được worker cập nhật.",
            };
          }
        }
      }

      const [enrichedInvoice] = await attachInvoiceTaxpayers(supabase, [invoiceWithTaxpayer]);
      if (enrichedInvoice) invoiceWithTaxpayer = enrichedInvoice as InvoiceRecord;
    } catch (taxpayerError) {
      console.error("invoice taxpayer synchronization failed", taxpayerError);
      taxpayerSync = {
        status: "error",
        message: "Đã lưu hóa đơn nhưng chưa đồng bộ được MST bên bán vào danh mục MST.",
      };
    }
  }

  return NextResponse.json({
    ok: true,
    invoice: invoiceWithTaxpayer,
    taxpayerSync,
    usage: { used: quota.used, limit: quota.limit, remaining: Math.max(0, quota.limit - quota.used) },
  }, { status: 201 });
}
