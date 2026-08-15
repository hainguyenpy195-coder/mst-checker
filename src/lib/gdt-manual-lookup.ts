import * as cheerio from "cheerio";
import { rootCertificates } from "node:tls";
import { Agent } from "undici";
import { normalizeTaxCode } from "@/lib/tax-code";
import { GLOBALSIGN_RSA_OV_SSL_CA_2018 } from "@/lib/gdt-ca";
import { normalizeTaxpayerName, taxpayerNamesMatch } from "@/lib/taxpayer-name";

const GDT_BASE_URL = "https://tracuunnt.gdt.gov.vn";
const GDT_LOOKUP_URL = `${GDT_BASE_URL}/tcnnt/mstdn.jsp`;
const DEFAULT_CAPTCHA_PATH = "/tcnnt/captcha.png?uid=";
const EMPTY_RESULT_RETRIES = 2;
const EMPTY_RESULT_RETRY_DELAYS_MS = [500, 1_000];
const GDT_HTTPS_AGENT = new Agent({
  // Keep Node's bundled roots and add the intermediate omitted by GDT.
  connect: { ca: [ ...rootCertificates, GLOBALSIGN_RSA_OV_SSL_CA_2018 ] },
});

export type GdtLookupRecord = {
  taxCode: string;
  name: string | null;
  address: string | null;
  taxDepartment: string | null;
  status: string | null;
};

export type GdtLookupSession = {
  cookieHeader: string;
  captchaDataUrl: string;
};

export class GdtLookupError extends Error {
  constructor(
    message: string,
    public readonly kind: "captcha" | "not_found" | "empty" | "upstream" | "parse" | "ambiguous",
    public readonly candidates: GdtLookupRecord[] = [],
  ) {
    super(message);
    this.name = "GdtLookupError";
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

export function mergeCookieHeader(currentCookieHeader: string, setCookieValues: string[]) {
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
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function requestGdt(
  url: string,
  init: RequestInit = {},
  cookieHeader = "",
) {
  const headers = new Headers(init.headers);
  headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  headers.set("Cache-Control", "no-cache");
  headers.set("Referer", GDT_LOOKUP_URL);
  if (cookieHeader) headers.set("Cookie", cookieHeader);

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers,
      cache: "no-store",
      redirect: "follow",
      dispatcher: GDT_HTTPS_AGENT,
    } as RequestInit & { dispatcher: Agent });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error
      ? ` (${error.cause.message})`
      : "";
    throw new GdtLookupError(`Không thể kết nối tới trang Cục Thuế${cause}.`, "upstream");
  }
  const nextCookieHeader = mergeCookieHeader(cookieHeader, getSetCookieValues(response.headers));
  return { response, nextCookieHeader };
}

function captchaUrlFromHtml(html: string) {
  const $ = cheerio.load(html);
  const source = $("img[src*='captcha']").first().attr("src") ?? DEFAULT_CAPTCHA_PATH;
  return new URL(source, GDT_BASE_URL).toString();
}

async function loadCaptcha(cookieHeader: string, html: string) {
  const captchaResponse = await requestGdt(captchaUrlFromHtml(html), {}, cookieHeader);
  if (!captchaResponse.response.ok) {
    throw new GdtLookupError(`Không thể tải CAPTCHA từ Cục Thuế (HTTP ${captchaResponse.response.status}).`, "upstream");
  }
  const contentType = captchaResponse.response.headers.get("content-type") ?? "image/png";
  const image = Buffer.from(await captchaResponse.response.arrayBuffer()).toString("base64");
  return {
    cookieHeader: captchaResponse.nextCookieHeader,
    captchaDataUrl: `data:${contentType};base64,${image}`,
  };
}

export async function createGdtLookupSession(): Promise<GdtLookupSession> {
  const pageResponse = await requestGdt(GDT_LOOKUP_URL);
  if (!pageResponse.response.ok) {
    throw new GdtLookupError(`Không thể mở trang tra cứu Cục Thuế (HTTP ${pageResponse.response.status}).`, "upstream");
  }
  const html = await pageResponse.response.text();
  return loadCaptcha(pageResponse.nextCookieHeader, html);
}

function cleanText(value: string | undefined) {
  const cleaned = (value ?? "").replace(/\s+/g, " ").trim();
  return cleaned || null;
}

function normalizedCell(value: string | undefined) {
  return (value ?? "").toLocaleLowerCase("vi-VN").replace(/\s+/g, " ").trim();
}

function isTaxCode(value: string) {
  return /^(?:\d{10}|\d{10}-\d{3}|\d{12})$/.test(normalizeTaxCode(value));
}

function extractRows(html: string) {
  const $ = cheerio.load(html);
  return $("tr").toArray().map((row) => $(row).children("th,td").toArray().map((cell) => cleanText($(cell).text()) ?? ""));
}

function parseResult(html: string, requestedTaxCode: string, referenceNames: string[] = []): GdtLookupRecord {
  const $ = cheerio.load(html);
  const bodyText = normalizedCell($("body").text());
  if (/vui lòng nhập đúng mã xác nhận|mã xác nhận.{0,50}(không đúng|không chính xác|sai)/i.test(bodyText)) {
    throw new GdtLookupError("Mã CAPTCHA chưa đúng. Vui lòng nhập lại.", "captcha");
  }
  if (/không tìm thấy người nộp thuế nào phù hợp|không có thông tin|không tồn tại/i.test(bodyText)) {
    throw new GdtLookupError("Cục Thuế không tìm thấy thông tin cho MST này.", "not_found");
  }

  const rows = extractRows(html);
  const headerIndex = rows.findIndex((row) => row.some((cell) => /trạng thái mst/i.test(cell)));
  if (headerIndex < 0 && $("form[name='myform']").length > 0) {
    throw new GdtLookupError("Cục Thuế trả về trang kết quả rỗng.", "empty");
  }
  if (headerIndex < 0) {
    throw new GdtLookupError("Không nhận diện được bảng kết quả từ Cục Thuế.", "parse");
  }

  const headers = rows[headerIndex].map(normalizedCell);
  const resultRows = rows.slice(headerIndex + 1).filter((row) => row.some(isTaxCode));
  if (!resultRows.length) throw new GdtLookupError("Cục Thuế trả về bảng kết quả rỗng.", "empty");

  const normalizedRequestedTaxCode = normalizeTaxCode(requestedTaxCode);
  const findIndex = (pattern: RegExp) => headers.findIndex((header) => pattern.test(header));
  const records = resultRows
    .map((dataRow) => {
      const valueAt = (pattern: RegExp) => {
        const index = findIndex(pattern);
        return index >= 0 ? cleanText(dataRow[index]) : null;
      };
      return {
        taxCode: normalizeTaxCode(dataRow.find(isTaxCode) ?? ""),
        name: valueAt(/tên người nộp thuế|tên tổ chức|tên người nộp/),
        address: valueAt(/địa chỉ trụ sở|địa chỉ kinh doanh|địa chỉ/),
        taxDepartment: valueAt(/cơ quan thuế/),
        status: valueAt(/trạng thái mst|trạng thái mã số thuế/),
      } satisfies GdtLookupRecord;
    })
    .filter((record) => record.taxCode === normalizedRequestedTaxCode);

  if (!records.length) {
    throw new GdtLookupError(
      resultRows.length > 1
        ? "Cục Thuế trả về nhiều kết quả nhưng không có dòng khớp chính xác với MST đang tra cứu."
        : "Cục Thuế không trả về đúng dòng MST đang tra cứu.",
      "parse",
    );
  }
  if (records.length === 1) return records[0];

  const uniqueReferenceNames = [...new Set(referenceNames.map(normalizeTaxpayerName).filter(Boolean))];
  const nameMatches = uniqueReferenceNames.length === 1
    ? records.filter((record) => referenceNames.some((referenceName) => taxpayerNamesMatch(referenceName, record.name)))
    : [];
  if (nameMatches.length === 1) return nameMatches[0];

  throw new GdtLookupError(
    nameMatches.length > 1
      ? "Cục Thuế trả về nhiều dòng cùng MST và cùng tên tham chiếu; chưa thể tự chọn trạng thái an toàn."
      : "Cục Thuế trả về nhiều dòng cùng MST nhưng không có dòng khớp duy nhất với tên tham chiếu.",
    "ambiguous",
    records,
  );
}

export async function submitGdtLookup(
  taxCode: string,
  captcha: string,
  cookieHeader: string,
  referenceNames: string[] = [],
) {
  const form = new URLSearchParams({
    cm: "cm",
    mst: taxCode,
    fullname: "",
    address: "",
    cmt: "",
    captcha,
  });
  let requestCookieHeader = cookieHeader;

  for (let attempt = 0; attempt <= EMPTY_RESULT_RETRIES; attempt += 1) {
    const response = await requestGdt(GDT_LOOKUP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }, requestCookieHeader);
    if (!response.response.ok) {
      throw new GdtLookupError(`Cục Thuế trả về HTTP ${response.response.status}.`, "upstream");
    }

    const html = await response.response.text();
    try {
      return { record: parseResult(html, taxCode, referenceNames), cookieHeader: response.nextCookieHeader };
    } catch (error) {
      if (!(error instanceof GdtLookupError)) throw error;
      // CAPTCHA errors are returned immediately. The GDT site rotates the
      // CAPTCHA after this response, so the API must fetch a new image and
      // let the user enter the new value. Only an otherwise empty HTML page
      // is safe to retry automatically.
      if (error.kind !== "empty" || attempt >= EMPTY_RESULT_RETRIES) throw error;
      requestCookieHeader = response.nextCookieHeader;
      await new Promise((resolve) => setTimeout(resolve, EMPTY_RESULT_RETRY_DELAYS_MS[attempt] ?? 1_000));
    }
  }

  throw new GdtLookupError("Cục Thuế trả về dữ liệu rỗng sau nhiều lần thử.", "empty");
}

export async function refreshGdtCaptcha(cookieHeader: string) {
  const pageResponse = await requestGdt(GDT_LOOKUP_URL, {}, cookieHeader);
  if (!pageResponse.response.ok) {
    throw new GdtLookupError(`Không thể làm mới phiên CAPTCHA (HTTP ${pageResponse.response.status}).`, "upstream");
  }
  const html = await pageResponse.response.text();
  return loadCaptcha(pageResponse.nextCookieHeader, html);
}
