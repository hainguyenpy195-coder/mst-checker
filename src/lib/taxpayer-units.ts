export type TaxpayerUnitInfo = {
  key: string;
  sourceLabel: string;
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
  { key: "vpct", aliases: ["vpct"], order: 8 },
];

// Change display labels here when an organizational name changes. The key is
// intentionally stable so existing and future workbook rows remain grouped.
export const TAXPAYER_UNIT_DISPLAY_NAME_OVERRIDES: Readonly<Record<string, string>> = {
  "xuong-dvkt": "Trung tâm Bảo đảm Kỹ thuật",
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

function romanNumeralToNumber(value: string) {
  const roman = value.replace(/\.$/, "").toUpperCase();
  const values: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  let total = 0;
  let previous = 0;
  for (const character of [...roman].reverse()) {
    const current = values[character] ?? 0;
    total += current < previous ? -current : current;
    previous = current;
  }
  return total > 0 ? total : null;
}

const definitionByAlias = new Map<string, TaxpayerUnitDefinition>();
for (const definition of TAXPAYER_UNIT_DEFINITIONS) {
  for (const alias of definition.aliases) definitionByAlias.set(normalizeUnitLabel(alias), definition);
}

export function resolveTaxpayerUnit(sourceLabel: string, marker: string): TaxpayerUnitInfo {
  const normalizedLabel = normalizeUnitLabel(sourceLabel);
  const definition = definitionByAlias.get(normalizedLabel);
  const key = definition?.key ?? slugifyUnitLabel(sourceLabel);
  const order = definition?.order ?? romanNumeralToNumber(marker);
  return {
    key,
    sourceLabel: sourceLabel.trim(),
    displayName: TAXPAYER_UNIT_DISPLAY_NAME_OVERRIDES[key] ?? sourceLabel.trim(),
    order,
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
