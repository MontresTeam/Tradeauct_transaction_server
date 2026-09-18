import { describe, expect, it } from "vitest";
import { AppError } from "./errors/AppError.js";
import { currencyExponent, fromMinorUnits, minorEquals, sumMinor, toMinorUnits } from "./money.js";

describe("money", () => {
  it("uses two decimals for AED and the other common currencies", () => {
    expect(currencyExponent("AED")).toBe(2);
    expect(toMinorUnits(48500, "AED")).toBe(4850000n);
    expect(toMinorUnits(48500.25, "aed")).toBe(4850025n);
  });

  it("uses no decimals for zero-decimal currencies", () => {
    // The `Math.round(x * 100)` that the old payment module used everywhere
    // would have charged a JPY buyer a hundred times the intended amount.
    expect(currencyExponent("JPY")).toBe(0);
    expect(toMinorUnits(4500, "JPY")).toBe(4500n);
  });

  it("uses three decimals for KWD and friends", () => {
    expect(currencyExponent("KWD")).toBe(3);
    expect(toMinorUnits(12.345, "KWD")).toBe(12345n);
  });

  it("rounds half away from zero at the minor unit", () => {
    expect(toMinorUnits(0.005, "AED")).toBe(1n);
    expect(toMinorUnits(10.994, "AED")).toBe(1099n);
    expect(toMinorUnits(10.995, "AED")).toBe(1100n);
  });

  it("round-trips through minor units", () => {
    expect(fromMinorUnits(4850025n, "AED")).toBe(48500.25);
    expect(fromMinorUnits(4500n, "JPY")).toBe(4500);
  });

  it("rejects an unknown currency", () => {
    expect(() => toMinorUnits(10, "WATCHES")).toThrow(AppError);
    expect(() => toMinorUnits(10, "")).toThrow(AppError);
  });

  it("rejects amounts that are not finite numbers", () => {
    expect(() => toMinorUnits(Number.NaN, "AED")).toThrow(AppError);
    expect(() => toMinorUnits(Number.POSITIVE_INFINITY, "AED")).toThrow(AppError);
  });

  it("sums and compares without floating point drift", () => {
    const parts = [toMinorUnits(0.1, "AED"), toMinorUnits(0.2, "AED")];
    expect(sumMinor(parts)).toBe(30n);
    expect(minorEquals(sumMinor(parts), 30)).toBe(true);
    // 0.1 + 0.2 !== 0.3 in floating point; in minor units it does.
    expect(0.1 + 0.2 === 0.3).toBe(false);
  });
});
