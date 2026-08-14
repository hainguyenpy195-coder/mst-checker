import * as cheerio from "cheerio";
import { rootCertificates } from "node:tls";
import { Agent } from "undici";
import { normalizeTaxCode } from "@/lib/tax-code";
import { GLOBALSIGN_RSA_OV_SSL_CA_2018 } from "@/lib/gdt-ca";

const GDT_INVOICE_BASE_URL = "https://tracuuhoadon.gdt.gov.vn";
const GDT_INVOICE_LOOKUP_URL = GDT_INVOICE_BASE_URL + "/tc1hd.html";
const GDT_INVOICE_HTTPS_AGENT = new Agent({
  connect: { ca: [...rootCertificates, GLOBALSIGN_RSA_OV_SSL_CA_2018] },
});

export type InvoiceGdtFields = {
  sellerTaxCode: string;
  templateNumber: string;
  symbol: string;
  invoiceNumber: string;
};

export type InvoiceGdtSession = {
  cookieHeader: string;
  captchaDataUrl: string;
  formAction: string;
  hiddenFields: Array<[string, string]>;
};

export type InvoiceGdtVerificationResult = {
  status: "valid" | "invalid";
  statusText: string;
  message: string;
  resultText: string;
};

export class InvoiceGdtLookupError extends Error {
  constructor(
    message: string,
    public readonly kind: "captcha" | "not_found" | "upstream" | "parse",
  ) {
    super(message);
    this.name = "InvoiceGdtLookupError";
  }
}

function getSetCookieValues(headers: Headers) {
  const headersWithGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const values = headersWithGetSetCookie.getSetCookie?.();
  if (values?.length) return values;

  const combined = headers.get("set-cookie");
  if (!combined) return [];
  return combined.split(/,(?=\s*[^;,=\s]+=[^;,]+)/);
}

function mergeCookieHeader(currentCookieHeader: string, setCookieValues: string[]) {
  const cookies = new Map<string, string>();
  for (const value of currentCookieHeader.split(";")) {
    const separator = value.indexOf("=");
    if (separator > 0) cookies.set(value.slice(0, separator).trim(), value.slice(separator + 1).trim());
  }
  for (const value of setCookieValues) {
    const firstPart = value.split(";", 1)[0];
    const separator = firstPart.indexOf("=");
    if (separator > 0) cookies.set(firstPart.slice(0, separator).trim(), firstPart.slice(separator + 1).trim());
  }
  return [...cookies.entries()].map(([name, value]) => name + "=" + value).join("; ");
}

async function requestGdtInvoice(url: string, init: RequestInit = {}, cookieHeader = "") {
  const headers = new Headers(init.headers);
  headers.set("Accept", "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8");
  headers.set("Cache-Control", "no-cache");
  headers.set("Referer", GDT_INVOICE_LOOKUP_URL);
  if (cookieHeader) headers.set("Cookie", cookieHeader);

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers,
      cache: "no-store",
      redirect: "follow",
      dispatcher: GDT_INVOICE_HTTPS_AGENT,
    } as RequestInit & { dispatcher: Agent });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error
      ? " (" + error.cause.message + ")"
      : "";
    throw new InvoiceGdtLookupError("Không thể kết nối tới trang tra cứu hóa đơn Cục Thuế" + cause + ".", "upstream");
  }

  return {
    response,
    nextCookieHeader: mergeCookieHeader(cookieHeader, getSetCookieValues(response.headers)),
  };
}

function cleanText(value: string | undefined) {
  const cleaned = (value ?? "").replace(/\s+/g, " ").trim();
  return cleaned || null;
}

function normalizedText(value: string | null | undefined) {
  return (value ?? "").normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase("vi-VN");
}

function captchaUrlFromHtml(html: string) {
  const $ = cheerio.load(html);
  const source = $("img#captchaImage").attr("src")
    ?? $("img[src*='Captcha'], img[src*='captcha']").first().attr("src")
    ?? "Captcha.jpg";
  return new URL(source, GDT_INVOICE_BASE_URL).toString();
}

function readFormState(html: string) {
  const $ = cheerio.load(html);
  const form = $("form#tc1hdform, form[name='tc1hdform'], form").first();
  const action = form.attr("action") ?? "/search1hd.html";
  const hiddenFields: Array<[string, string]> = [];
  form.find("input[type='hidden'][name]").each((_, element) => {
    hiddenFields.push([String($(element).attr("name")), String($(element).attr("value") ?? "")]);
  });
  return {
    formAction: new URL(action, GDT_INVOICE_BASE_URL).toString(),
    hiddenFields,
  };
}

async function loadCaptcha(cookieHeader: string, html: string, formState: ReturnType<typeof readFormState>) {
  const captchaResponse = await requestGdtInvoice(captchaUrlFromHtml(html), {}, cookieHeader);
  if (!captchaResponse.response.ok) {
    throw new InvoiceGdtLookupError("Không thể tải CAPTCHA từ Cục Thuế (HTTP " + captchaResponse.response.status + ").", "upstream");
  }
  const contentType = captchaResponse.response.headers.get("content-type") ?? "image/jpeg";
  const image = Buffer.from(await captchaResponse.response.arrayBuffer()).toString("base64");
  return {
    cookieHeader: captchaResponse.nextCookieHeader,
    captchaDataUrl: "data:" + contentType + ";base64," + image,
    ...formState,
  };
}

export async function createInvoiceGdtSession(): Promise<InvoiceGdtSession> {
  const pageResponse = await requestGdtInvoice(GDT_INVOICE_LOOKUP_URL);
  if (!pageResponse.response.ok) {
    throw new InvoiceGdtLookupError("Không thể mở trang tra cứu hóa đơn Cục Thuế (HTTP " + pageResponse.response.status + ").", "upstream");
  }
  const html = await pageResponse.response.text();
  return loadCaptcha(pageResponse.nextCookieHeader, html, readFormState(html));
}

async function validateCaptcha(captcha: string, cookieHeader: string) {
  const form = new URLSearchParams({ captchaCode: captcha });
  const response = await requestGdtInvoice(GDT_INVOICE_BASE_URL + "/validcode.html", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Accept: "application/json, text/javascript, */*; q=0.01" },
    body: form.toString(),
  }, cookieHeader);
  if (!response.response.ok) {
    throw new InvoiceGdtLookupError("Cục Thuế không thể kiểm tra CAPTCHA (HTTP " + response.response.status + ").", "upstream");
  }

  const text = await response.response.text();
  try {
    const payload = JSON.parse(text) as { strMess?: string | null };
    if (payload.strMess) throw new InvoiceGdtLookupError("Mã CAPTCHA chưa đúng. Vui lòng nhập lại.", "captcha");
  } catch (error) {
    if (error instanceof InvoiceGdtLookupError) throw error;
    // Some deployments return an empty/plain response for a valid CAPTCHA.
  }
  return response.nextCookieHeader;
}

function extractRows(html: string) {
  const $ = cheerio.load(html);
  return $("tr").toArray().map((row) => $(row).children("th,td").toArray().map((cell) => cleanText($(cell).text()) ?? ""));
}

function parseResult(html: string, fields: InvoiceGdtFields): InvoiceGdtVerificationResult {
  const $ = cheerio.load(html);
  const bodyText = normalizedText($("body").text());
  if (/mã xác thực.{0,60}(không đúng|không chính xác|sai)|captcha.{0,40}(không đúng|sai)/i.test(bodyText)) {
    throw new InvoiceGdtLookupError("Mã CAPTCHA chưa đúng. Vui lòng nhập lại.", "captcha");
  }

  const rows = extractRows(html);
  const valueAt = (pattern: RegExp) => {
    for (const row of rows) {
      if (pattern.test(normalizedText(row[0]))) return cleanText(row.slice(1).join(" "));
    }
    return null;
  };

  const statusText = valueAt(/trạng thái hóa đơn/) ?? "";
  const resultText = cleanText($("body").text()) ?? "";
  if (!statusText) {
    if (/không tìm thấy|không có thông tin|không tồn tại|không phù hợp/i.test(bodyText)) {
      throw new InvoiceGdtLookupError("Cục Thuế không tìm thấy hóa đơn phù hợp.", "not_found");
    }
    throw new InvoiceGdtLookupError("Không nhận diện được kết quả hóa đơn từ Cục Thuế.", "parse");
  }

  const resultTaxCode = valueAt(/mã số thuế người bán|mã số thuế/);
  if (resultTaxCode && normalizeTaxCode(resultTaxCode) !== normalizeTaxCode(fields.sellerTaxCode)) {
    throw new InvoiceGdtLookupError("Kết quả Cục Thuế không khớp mã số thuế người bán.", "parse");
  }
  const resultInvoiceNumber = valueAt(/số hóa đơn/);
  if (resultInvoiceNumber && resultInvoiceNumber.replace(/\s+/g, "") !== fields.invoiceNumber.replace(/\s+/g, "")) {
    throw new InvoiceGdtLookupError("Kết quả Cục Thuế không khớp số hóa đơn.", "parse");
  }

  const status = normalizedText(statusText);
  const invalid = /không hợp lệ|không tồn tại|hết giá trị|không còn giá trị|đã hủy|đã huỷ|bị hủy|bị huỷ|không sử dụng|không có giá trị/.test(status);
  const valid = /hợp lệ|còn giá trị|đang sử dụng|đã sử dụng|đã cấp mã|đã phát hành/.test(status);
  if (!invalid && !valid) {
    throw new InvoiceGdtLookupError("Cục Thuế trả về trạng thái chưa xác định: " + statusText + ".", "parse");
  }

  return {
    status: invalid ? "invalid" : "valid",
    statusText,
    message: invalid ? "Hóa đơn không hợp lệ theo Cục Thuế: " + statusText + "." : "Hóa đơn hợp lệ theo Cục Thuế: " + statusText + ".",
    resultText: resultText.slice(0, 20000),
  };
}

export async function submitInvoiceGdtLookup(
  fields: InvoiceGdtFields,
  captcha: string,
  session: Pick<InvoiceGdtSession, "cookieHeader" | "formAction" | "hiddenFields">,
) {
  const cookieHeader = await validateCaptcha(captcha, session.cookieHeader);
  const form = new URLSearchParams();
  for (const [name, value] of session.hiddenFields) form.append(name, value);
  form.set("tin", fields.sellerTaxCode);
  form.set("mau", fields.templateNumber);
  form.set("kyhieu", fields.symbol);
  form.set("so", fields.invoiceNumber);
  form.set("captchaCodeVerify", captcha);

  const response = await requestGdtInvoice(session.formAction, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: form.toString(),
  }, cookieHeader);
  if (!response.response.ok) {
    throw new InvoiceGdtLookupError("Cục Thuế trả về HTTP " + response.response.status + ".", "upstream");
  }

  const html = await response.response.text();
  return { result: parseResult(html, fields), cookieHeader: response.nextCookieHeader };
}

export async function refreshInvoiceGdtCaptcha() {
  return createInvoiceGdtSession();
}
