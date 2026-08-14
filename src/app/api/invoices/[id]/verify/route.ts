import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/app-auth";
import { normalizeInvoiceLookupCode, normalizeInvoiceLookupUrl } from "@/lib/invoice-extraction";
import { INVOICE_SELECT } from "@/lib/invoice-db";
import { attachInvoiceTaxpayers } from "@/lib/invoice-taxpayer";
import { createAdminClient } from "@/lib/supabase/admin";
import type { InvoiceRecord } from "@/lib/invoice-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type VerificationResultStatus = Extract<InvoiceRecord["verification_status"], "valid" | "invalid">;

type VerifyBody = {
  action?: "save-lookup" | "record";
  lookupUrl?: unknown;
  lookupCode?: unknown;
  status?: VerificationResultStatus;
};

type InvoiceForVerification = Pick<InvoiceRecord, "id" | "invoice_number" | "lookup_url" | "lookup_code">;

function readText(value: unknown) {
  return typeof value === "string" ? value : null;
}

function normalizeLookup(body: VerifyBody) {
  return {
    lookupUrl: normalizeInvoiceLookupUrl(readText(body.lookupUrl)),
    lookupCode: normalizeInvoiceLookupCode(readText(body.lookupCode)),
  };
}

async function readInvoice(supabase: ReturnType<typeof createAdminClient>, invoiceId: string) {
  return supabase
    .from("invoices")
    .select("id, invoice_number, lookup_url, lookup_code")
    .eq("id", invoiceId)
    .maybeSingle<InvoiceForVerification>();
}

async function readUpdatedInvoice(supabase: ReturnType<typeof createAdminClient>, invoiceId: string) {
  const { data, error } = await supabase
    .from("invoices")
    .select(INVOICE_SELECT)
    .eq("id", invoiceId)
    .single();
  if (error || !data) throw new Error("Không thể đọc hóa đơn sau khi cập nhật.");
  const [invoice] = await attachInvoiceTaxpayers(supabase, [data as unknown as InvoiceRecord]);
  return invoice;
}

async function saveLookup(invoiceId: string, body: VerifyBody) {
  const supabase = createAdminClient();
  const { data: invoice, error: invoiceError } = await readInvoice(supabase, invoiceId);
  if (invoiceError) throw new Error("Không thể đọc dữ liệu hóa đơn.");
  if (!invoice) return NextResponse.json({ error: "Không tìm thấy hóa đơn." }, { status: 404 });

  const { lookupUrl, lookupCode } = normalizeLookup(body);
  if (!lookupUrl || !lookupCode) {
    return NextResponse.json({ error: "Vui lòng nhập đúng địa chỉ trang tra cứu và mã tra cứu." }, { status: 422 });
  }

  const { error: updateError } = await supabase
    .from("invoices")
    .update({ lookup_url: lookupUrl, lookup_code: lookupCode })
    .eq("id", invoiceId);
  if (updateError) throw new Error("Không thể lưu thông tin tra cứu hóa đơn.");

  return NextResponse.json({ ok: true, invoice: await readUpdatedInvoice(supabase, invoiceId) });
}

async function recordVerification(invoiceId: string, body: VerifyBody) {
  if (body.status !== "valid" && body.status !== "invalid") {
    return NextResponse.json({ error: "Kết quả đối chiếu không hợp lệ." }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: invoice, error: invoiceError } = await readInvoice(supabase, invoiceId);
  if (invoiceError) throw new Error("Không thể đọc dữ liệu hóa đơn.");
  if (!invoice) return NextResponse.json({ error: "Không tìm thấy hóa đơn." }, { status: 404 });

  const providedLookup = normalizeLookup(body);
  const lookupUrl = providedLookup.lookupUrl ?? normalizeInvoiceLookupUrl(invoice.lookup_url);
  const lookupCode = providedLookup.lookupCode ?? normalizeInvoiceLookupCode(invoice.lookup_code);
  if (!lookupUrl || !lookupCode) {
    return NextResponse.json({ error: "Hóa đơn chưa có đầy đủ địa chỉ trang tra cứu và mã tra cứu." }, { status: 422 });
  }

  const isValid = body.status === "valid";
  const message = isValid
    ? "Đã xác minh: hóa đơn hợp lệ theo kết quả tra cứu của nhà cung cấp."
    : "Đã xác minh: hóa đơn không hợp lệ theo kết quả tra cứu của nhà cung cấp.";
  const now = new Date().toISOString();
  const { error: updateError } = await supabase
    .from("invoices")
    .update({
      lookup_url: lookupUrl,
      lookup_code: lookupCode,
      verification_status: body.status,
      verification_message: message,
      verification_result: {
        source: "invoice_provider_lookup",
        lookupUrl,
        lookupCode,
        status: body.status,
        recordedAt: now,
      },
      verified_at: now,
    })
    .eq("id", invoiceId);
  if (updateError) throw new Error("Không thể cập nhật tình trạng hóa đơn.");

  return NextResponse.json({ ok: true, invoice: await readUpdatedInvoice(supabase, invoiceId) });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await authenticateRequest(request);
  if (!session) return NextResponse.json({ error: "Bạn cần đăng nhập." }, { status: 401 });

  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Mã hóa đơn không hợp lệ." }, { status: 400 });

  let body: VerifyBody;
  try {
    body = await request.json() as VerifyBody;
  } catch {
    return NextResponse.json({ error: "Dữ liệu đối chiếu không hợp lệ." }, { status: 400 });
  }

  try {
    if (body.action === "save-lookup") return await saveLookup(id, body);
    if (body.action === "record") return await recordVerification(id, body);
    return NextResponse.json({ error: "Thao tác đối chiếu không hợp lệ." }, { status: 400 });
  } catch (error) {
    console.error("invoice provider verification failed", error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Không thể cập nhật thông tin đối chiếu hóa đơn.",
    }, { status: 500 });
  }
}
