/**
 * Normalizes names only for comparison. The value saved from the endpoint or
 * Cục Thuế is kept untouched so the UI can display the official spelling.
 */
export function normalizeTaxpayerName(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLocaleLowerCase("vi-VN")
    .replace(/\s+/g, " ")
    .trim();
}

export function taxpayerNamesMatch(left: string | null | undefined, right: string | null | undefined) {
  const normalizedLeft = normalizeTaxpayerName(left);
  const normalizedRight = normalizeTaxpayerName(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}
