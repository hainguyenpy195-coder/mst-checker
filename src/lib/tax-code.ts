export type TaxCodeType = "enterprise" | "branch" | "household";

export const TAX_CODE_FORMAT_MESSAGE =
  "Mã số thuế phải thuộc một trong 3 dạng: doanh nghiệp 10 số, chi nhánh 10 số - 3 số hoặc hộ kinh doanh 12 số.";

export const TAX_CODE_FORMAT_HINT =
  "Doanh nghiệp: 10 số · Chi nhánh: 10 số - 3 số · Hộ kinh doanh: 12 số";

// HTML pattern values are kept separate from the RegExp so the same rule can
// be applied by the browser before the request reaches the API route.
export const TAX_CODE_INPUT_PATTERN = "(?:[0-9]{10}|[0-9]{10}-[0-9]{3}|[0-9]{12})";

export function normalizeTaxCode(value: string) {
  return value.trim().replace(/\s+/g, "").replace(/[–—]/g, "-");
}

export function getTaxCodeType(value: string): TaxCodeType | null {
  const taxCode = normalizeTaxCode(value);
  if (/^\d{10}$/.test(taxCode)) return "enterprise";
  if (/^\d{10}-\d{3}$/.test(taxCode)) return "branch";
  if (/^\d{12}$/.test(taxCode)) return "household";
  return null;
}

export function isValidTaxCode(value: string) {
  return getTaxCodeType(value) !== null;
}
