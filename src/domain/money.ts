/**
 * Money helpers. JS has no Decimal, so amounts cross JSON/LLM boundaries as numbers in
 * major units, and all arithmetic / comparisons happen in integer cents.
 */

export type Cents = number & { readonly __brand: "Cents" };

export function toCents(amount: number): Cents {
  if (!Number.isFinite(amount)) throw new RangeError(`Invalid amount: ${amount}`);
  return Math.round(amount * 100) as Cents;
}

export function fromCents(cents: Cents): number {
  return cents / 100;
}

export function mulCents(unit: Cents, quantity: number): Cents {
  return Math.round(unit * quantity) as Cents;
}

/** True when |a - b| is within `tolerance` (fraction of the larger value, default 1%). */
export function approxEqual(a: Cents, b: Cents, tolerance = 0.01): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) <= scale * tolerance;
}

export function formatMoney(amount: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(amount);
}
