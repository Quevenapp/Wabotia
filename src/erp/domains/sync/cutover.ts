/** erp_cutover.stock_observation_id */
export function stockObservationId(value: unknown): string | null {
  if (typeof value === "string") return value.length <= 40 && !/[^0-9]/.test(value) && /[1-9]/.test(value) ? value : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 9007199254740991)
    return String(value);
  return null;
}
