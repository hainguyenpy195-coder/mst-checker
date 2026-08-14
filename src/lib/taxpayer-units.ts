export type TaxpayerUnitInfo = {
  key: string;
  sourceLabel: string;
  sourceMarker: string;
  displayName: string;
  order: number | null;
};

type TaxpayerUnitDefinition = {
  key: string;
  aliases: string[];
  order: number;
};

const TAXPAYER_UNIT_DEFINITIONS: TaxpayerUnitDefinition[] = [
  { key: "xuong-dvkt", aliases: ["xuong dvkt", "xuong dich vu ky thuat", "trung tam bao dam ky thuat"], order: 1 },
  { key: "phong-tckt", aliases: ["phong tckt"], order: 2 },
  { key: "phong-khkd", aliases: ["phong khkd"], order: 3 },
  { key: "phong-ktatcl", aliases: ["phong ktatcl"], order: 4 },
  { key: "phong-ncpt", aliases: ["phong ncpt"], order: 5 },
  { key: "phong-tccbld", aliases: ["phong tccbld"], order: 6 },
  { key: "tt-huan-luyen-cns", aliases: ["tt huan luyen cns"], order: 7 },
  { key: "vpct", aliases: ["vpct", "vpct chinh"], order: 8 },
];

// Change display labels here when an organizational name changes. The key is
// intentionally stable so existing and future workbook rows remain grouped.
export const TAXPAYER_UNIT_DISPLAY_NAME_OVERRIDES: Readonly<Record<string, string>> = {
  "xuong-dvkt": "Trung tâm Bảo đảm Kỹ thuật",
  "phong-tckt": "Phòng Tài chính kế toán",
  "phong-khkd": "Phòng Kế hoạch kinh doanh",
  "phong-ktatcl": "Phòng Kỹ thuật An toàn Chất lượng",
  "phong-ncpt": "Phòng Nghiên cứu phát triển",
  "phong-tccbld": "Phòng Tổ chức cán bộ lao động",
  "tt-huan-luyen-cns": "Trung tâm huấn luyện CNS",
  "vpct": "Văn phòng công ty",
};

function normalizeUnitLabel(value: string) {
  return value
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function slugifyUnitLabel(value: string) {
  return normalizeUnitLabel(value).replace(/\s+/g, "-") || "unclassified";
}

const definitionByAlias = new Map<string, TaxpayerUnitDefinition>();
for (const definition of TAXPAYER_UNIT_DEFINITIONS) {
  for (const alias of definition.aliases) definitionByAlias.set(normalizeUnitLabel(alias), definition);
}

export function resolveTaxpayerUnit(sourceLabel: string, marker: string): TaxpayerUnitInfo {
  const normalizedLabel = normalizeUnitLabel(sourceLabel);
  const definition = definitionByAlias.get(normalizedLabel);
  const key = definition?.key ?? slugifyUnitLabel(sourceLabel);
  const sourceMarker = marker.trim();
  return {
    key,
    sourceLabel: sourceLabel.trim(),
    sourceMarker,
    displayName: TAXPAYER_UNIT_DISPLAY_NAME_OVERRIDES[key] ?? sourceLabel.trim(),
    order: definition?.order ?? null,
  };
}

export function getTaxpayerUnitDisplayName(sourceUnitKey: string | null | undefined, sourceUnitLabel: string | null | undefined) {
  if (sourceUnitKey && TAXPAYER_UNIT_DISPLAY_NAME_OVERRIDES[sourceUnitKey]) {
    return TAXPAYER_UNIT_DISPLAY_NAME_OVERRIDES[sourceUnitKey];
  }
  return sourceUnitLabel?.trim() || "Chưa phân loại";
}

export function getTaxpayerUnitOrder(sourceUnitKey: string | null | undefined, sourceUnitOrder: number | null | undefined) {
  if (Number.isInteger(sourceUnitOrder)) return sourceUnitOrder as number;
  const definition = TAXPAYER_UNIT_DEFINITIONS.find((item) => item.key === sourceUnitKey);
  return definition?.order ?? Number.MAX_SAFE_INTEGER;
}

export function toRomanNumeral(value: number | null | undefined) {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 3999) return null;
  const pairs: Array<[number, string]> = [
    [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"],
    [100, "C"], [90, "XC"], [50, "L"], [40, "XL"],
    [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ];
  let remainder = value as number;
  let result = "";
  for (const [amount, symbol] of pairs) {
    while (remainder >= amount) {
      result += symbol;
      remainder -= amount;
    }
  }
  return result;
}

export function formatTaxpayerUnitHeading(
  sourceUnitKey: string | null | undefined,
  sourceUnitLabel: string | null | undefined,
  sourceUnitOrder: number | null | undefined,
  sourceUnitMarker?: string | null,
) {
  const label = getTaxpayerUnitDisplayName(sourceUnitKey, sourceUnitLabel);
  const sourceMarker = sourceUnitMarker?.trim();
  if (sourceMarker) return `${sourceMarker}${sourceMarker.endsWith(".") ? "" : "."} ${label}`;
  const marker = toRomanNumeral(getTaxpayerUnitOrder(sourceUnitKey, sourceUnitOrder));
  return marker ? `${marker}. ${label}` : label;
}
