import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/app-auth";
import { INVOICE_SELECT } from "@/lib/invoice-db";
import { deriveInvoiceTemplateNumber } from "@/lib/invoice-extraction";
import { InvoiceGdtLookupError, createInvoiceGdtSession, refreshInvoiceGdtCaptcha, submitInvoiceGdtLookup, type InvoiceGdtFields } from "@/lib/invoice-gdt-lookup";
import { createAdminClient } from "@/lib/supabase/admin";
import type { InvoiceRecord } from "@/lib/invoice-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SESSION_TTL_MS = 10 * 60 * 1000;

type InvoiceVerificationSession = {
  id: string;
  invoice_id: string;
  username: string;
  upstream_cookie: string;
  form_action: string;
  hidden_fields: unknown;
  expires_at: string;
};

type VerifyBody = {
  action?: "start" | "submit";
  challengeId?: string;
  captcha?: string;
};

type InvoiceForVerification = Pick<InvoiceRecord, "id" | "invoice_number" | "seller_tax_code" | "invoice_template_number" | "invoice_symbol" | "tax_amount" | "total_amount">;

function isExpired(value: string) {
  return new Date(value).getTime() <= Date.now();
}

function readHiddenFields(value: unknown): Array<[string, string]> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!Array.isArray(entry) || entry.length < 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string") return [];
    return [[entry[0], entry[1]]];
  });
}

function toGdtFields(invoice: InvoiceForVerification): InvoiceGdtFields | null {
  const storedTemplate = invoice.invoice_template_number?.trim();
  const templateNumber = storedTemplate && !/^(?:—|-|null)$/i.test(storedTemplate)
    ? storedTemplate
    : deriveInvoiceTemplateNumber(invoice.invoice_symbol);
  if (!invoice.seller_tax_code || !templateNumber || !invoice.invoice_symbol || !invoice.invoice_number) return null;
  return {
    sellerTaxCode: invoice.seller_tax_code,
    templateNumber,
    symbol: invoice.invoice_symbol,
    invoiceNumber: invoice.invoice_number,
  };
}

async function readInvoice(supabase: ReturnType<typeof createAdminClient>, id: string) {
  const result = await supabase
    .from("invoices")
    .select("id, invoice_number, seller_tax_code, invoice_template_number, invoice_symbol, tax_amount, total_amount")
    .eq("id", id)
    .maybeSingle<InvoiceForVerification>();
  return result;
}

async function startVerification(username: string, invoiceId: string) {
  const supabase = createAdminClient();
  const { data: invoice, error: invoiceError } = await readInvoice(supabase, invoiceId);
  if (invoiceError) throw new Error("Không thể đọc dữ liệu hóa đơn cần xác minh.");
  if (!invoice) return NextResponse.json({ error: "Không tìm thấy hóa đơn." }, { status: 404 });

  const fields = toGdtFields(invoice);
  if (!fields) {
    return NextResponse.json({ error: "Hóa đơn thiếu MST, ký hiệu, số hóa đơn hoặc không xác định được mẫu số từ ký hiệu." }, { status: 422 });
  }

  if (invoice.invoice_template_number !== fields.templateNumber) {
    const { error: templateUpdateError } = await supabase
      .from("invoices")
      .update({ invoice_template_number: fields.templateNumber })
      .eq("id", invoice.id);
    if (templateUpdateError) console.error("invoice template derivation update failed", templateUpdateError);
  }

  const gdtSession = await createInvoiceGdtSession();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await supabase.from("invoice_verification_sessions").delete().eq("username", username);
  const { data: session, error: sessionError } = await supabase
    .from("invoice_verification_sessions")
    .insert({
      invoice_id: invoiceId,
      username,
      upstream_cookie: gdtSession.cookieHeader,
      form_action: gdtSession.formAction,
      hidden_fields: gdtSession.hiddenFields,
      expires_at: expiresAt,
    })
    .select("id")
    .single<{ id: string }>();

  if (sessionError || !session) {
    console.error("invoice verification session insert failed", sessionError);
    throw new Error("Không thể tạo phiên CAPTCHA hóa đơn. Hãy kiểm tra migration invoice_verification_sessions.");
  }

  return NextResponse.json({
    ok: true,
    challengeId: session.id,
    invoiceId,
    captchaDataUrl: gdtSession.captchaDataUrl,
    expiresAt,
    fields: {
      sellerTaxCode: fields.sellerTaxCode,
      templateNumber: fields.templateNumber,
      symbol: fields.symbol,
      invoiceNumber: fields.invoiceNumber,
      taxAmount: invoice.tax_amount,
      totalAmount: invoice.total_amount,
    },
  });
}

async function refreshCaptcha(username: string, session: InvoiceVerificationSession) {
  const supabase = createAdminClient();
  const refreshed = await refreshInvoiceGdtCaptcha();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const { error } = await supabase
    .from("invoice_verification_sessions")
    .update({
      upstream_cookie: refreshed.cookieHeader,
      form_action: refreshed.formAction,
      hidden_fields: refreshed.hiddenFields,
      expires_at: expiresAt,
    })
    .eq("id", session.id)
    .eq("username", username);
  if (error) throw error;
  return { refreshed, expiresAt };
}

async function updateInvoiceFromVerification(invoiceId: string, result: { status: "valid" | "invalid" | "error"; message: string; resultText?: string; statusText?: string }) {
  const supabase = createAdminClient();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("invoices")
    .update({
      verification_status: result.status,
      verification_message: result.message,
      verification_result: {
        statusText: result.statusText ?? null,
        resultText: result.resultText ?? null,
      },
      verified_at: now,
    })
    .eq("id", invoiceId);
  if (error) throw new Error("Không thể cập nhật tình trạng xác minh hóa đơn.");

  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .select(INVOICE_SELECT)
    .eq("id", invoiceId)
    .single();
  if (invoiceError || !invoice) throw new Error("Không thể đọc hóa đơn sau khi xác minh.");
  return invoice;
}

async function submitVerification(username: string, invoiceId: string, body: VerifyBody) {
  if (!body.challengeId || !body.captcha?.trim()) {
    return NextResponse.json({ error: "Vui lòng nhập mã CAPTCHA." }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: lookupSession, error: sessionError } = await supabase
    .from("invoice_verification_sessions")
    .select("id, invoice_id, username, upstream_cookie, form_action, hidden_fields, expires_at")
    .eq("id", body.challengeId)
    .eq("username", username)
    .maybeSingle<InvoiceVerificationSession>();

  if (sessionError || !lookupSession || isExpired(lookupSession.expires_at)) {
    if (lookupSession) await supabase.from("invoice_verification_sessions").delete().eq("id", lookupSession.id);
    return NextResponse.json({ error: "Phiên CAPTCHA đã hết hạn. Vui lòng tạo phiên mới." }, { status: 410 });
  }
  if (lookupSession.invoice_id !== invoiceId) {
    return NextResponse.json({ error: "Hóa đơn không khớp với phiên CAPTCHA." }, { status: 400 });
  }

  const { data: invoice, error: invoiceError } = await readInvoice(supabase, invoiceId);
  if (invoiceError || !invoice) return NextResponse.json({ error: "Hóa đơn không còn tồn tại." }, { status: 404 });
  const fields = toGdtFields(invoice);
  if (!fields) return NextResponse.json({ error: "Hóa đơn thiếu trường dữ liệu cần thiết để đối chiếu." }, { status: 422 });

  try {
    const result = await submitInvoiceGdtLookup(fields, body.captcha.trim(), {
      cookieHeader: lookupSession.upstream_cookie,
      formAction: lookupSession.form_action,
      hiddenFields: readHiddenFields(lookupSession.hidden_fields),
    });
    await supabase.from("invoice_verification_sessions").delete().eq("id", lookupSession.id);
    const updatedInvoice = await updateInvoiceFromVerification(invoiceId, {
      status: result.result.status,
      message: result.result.message,
      resultText: result.result.resultText,
      statusText: result.result.statusText,
    });
    return NextResponse.json({ ok: true, invoice: updatedInvoice });
  } catch (error) {
    if (error instanceof InvoiceGdtLookupError && error.kind === "captcha") {
      const refreshed = await refreshCaptcha(username, lookupSession);
      return NextResponse.json({
        error: "Mã CAPTCHA chưa đúng. Vui lòng nhập mã mới theo ảnh vừa cập nhật.",
        captchaDataUrl: refreshed.refreshed.captchaDataUrl,
        captchaInvalid: true,
        expiresAt: refreshed.expiresAt,
      }, { status: 422 });
    }

    await supabase.from("invoice_verification_sessions").delete().eq("id", lookupSession.id);
    if (error instanceof InvoiceGdtLookupError && error.kind === "not_found") {
      const updatedInvoice = await updateInvoiceFromVerification(invoiceId, {
        status: "invalid",
        message: error.message,
        resultText: error.message,
      });
      return NextResponse.json({ ok: true, invoice: updatedInvoice });
    }

    const message = error instanceof Error ? error.message : "Không thể đối chiếu hóa đơn với Cục Thuế.";
    try {
      const updatedInvoice = await updateInvoiceFromVerification(invoiceId, { status: "error", message });
      return NextResponse.json({ error: message, invoice: updatedInvoice }, { status: 502 });
    } catch (updateError) {
      console.error("invoice verification error update failed", updateError);
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }
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
    return NextResponse.json({ error: "Dữ liệu xác minh không hợp lệ." }, { status: 400 });
  }

  try {
    if (body.action === "start") return await startVerification(session.username, id);
    if (body.action === "submit") return await submitVerification(session.username, id, body);
    return NextResponse.json({ error: "Thao tác xác minh không hợp lệ." }, { status: 400 });
  } catch (error) {
    console.error("invoice verification failed", error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Không thể mở luồng xác minh hóa đơn.",
    }, { status: 502 });
  }
}
