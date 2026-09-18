/**
 * Money handling.
 *
 * Amounts are integers in the currency's minor unit. `Math.round(x * 100)` is
 * wrong for the zero-decimal currencies (JPY, KRW) and the three-decimal ones
 * (KWD, BHD, OMR, TND) that Stripe supports, so the exponent is always looked
 * up rather than assumed.
 */
import { AppError } from "./errors/AppError.js";

const ZERO_DECIMAL = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

const THREE_DECIMAL = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

export function currencyExponent(currency: string): number {
  const code = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new AppError(400, `Unsupported currency: ${currency}`, "UNSUPPORTED_CURRENCY");
  }
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

/** Convert a major-unit amount (e.g. 48500.25 AED) to minor units (4850025). */
export function toMinorUnits(amount: number, currency: string): bigint {
  if (!Number.isFinite(amount)) {
    throw new AppError(400, "Amount is not a finite number", "INVALID_AMOUNT");
  }

  const factor = 10 ** currencyExponent(currency);
  const scaled = Math.round(amount * factor);

  if (!Number.isSafeInteger(scaled)) {
    throw new AppError(400, "Amount is out of range", "INVALID_AMOUNT");
  }

  return BigInt(scaled);
}

/** Convert minor units back to a major-unit number, for display only. */
export function fromMinorUnits(amountMinor: bigint, currency: string): number {
  const factor = 10 ** currencyExponent(currency);
  return Number(amountMinor) / factor;
}

/** Stripe wants the minor-unit amount as a JS number. */
export function toStripeAmount(amountMinor: bigint): number {
  const value = Number(amountMinor);
  if (!Number.isSafeInteger(value)) {
    throw new AppError(400, "Amount is out of range for Stripe", "INVALID_AMOUNT");
  }
  return value;
}

export function sumMinor(amounts: bigint[]): bigint {
  return amounts.reduce((total, amount) => total + amount, 0n);
}

/** Equality that does not care whether a value arrived as string, number or bigint. */
export function minorEquals(a: bigint | number | string, b: bigint | number | string): boolean {
  return BigInt(a) === BigInt(b);
}
