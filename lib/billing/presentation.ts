/** Unknown provider amounts and missing currencies never become a zero-dollar receipt. */
export function receiptAmount(amountCents: number | null, currency: string | null, locale: string, unknown: string): string {
  if (amountCents === null || !Number.isFinite(amountCents) || !currency || !/^[a-z]{3}$/i.test(currency)) return unknown
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency: currency.toUpperCase() }).format(amountCents / 100) }
  catch { return unknown }
}
