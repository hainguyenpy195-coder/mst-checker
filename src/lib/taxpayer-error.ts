export const TAXPAYER_NOT_FOUND_MESSAGE = "Không tìm thấy mã số thuế hoặc chưa chính xác.";

export function formatTaxpayerError(value: string | null | undefined) {
  if (!value) return null;
  const message = value.trim();
  if (/^(?:XINVOICE_HTTP_404;\s*VIETQR_NO_DATA(?::.*)?|VIETQR_NO_DATA(?::.*)?;\s*XINVOICE_HTTP_404)$/i.test(message)) {
    return TAXPAYER_NOT_FOUND_MESSAGE;
  }
  return value;
}
