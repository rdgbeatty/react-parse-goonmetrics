import { formatMarketPrice } from "./marketPriceFormatting.ts";

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, received ${actual}`);
  }
}

Deno.test("formatMarketPrice removes .00 for market-precision integers", () => {
  assertEqual(formatMarketPrice(1234), "1,234", "4-significant-digit integers should render as whole numbers");
  assertEqual(formatMarketPrice(123400), "123,400", "integers with trailing zeroes after 4 significant digits should render as whole numbers");
  assertEqual(formatMarketPrice(1000000), "1,000,000", "1-significant-digit integers should render as whole numbers");
});

Deno.test("formatMarketPrice keeps decimals for values with an actual fractional component", () => {
  assertEqual(formatMarketPrice(1234.56), "1,234.56", "fractional prices should keep two decimals");
  assertEqual(formatMarketPrice(12.3), "12.30", "fractional prices should keep trailing display precision");
});

Deno.test("formatMarketPrice keeps decimals for integers that exceed market precision", () => {
  assertEqual(formatMarketPrice(12345), "12,345.00", "5-significant-digit integers should stay in fixed-decimal form");
  assertEqual(formatMarketPrice(1000500), "1,000,500.00", "integers with non-zero digits after the first 4 significant figures should stay in fixed-decimal form");
});
