export function formatMarketPrice(value: number): string {
  if (shouldDisplayAsWholeNumber(value)) {
    return value.toLocaleString("en-US", {
      maximumFractionDigits: 0,
    });
  }

  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function shouldDisplayAsWholeNumber(value: number): boolean {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return false;
  }

  return hasAtMostFourSignificantDigitsBeforeTrailingZeroes(Math.abs(value));
}

function hasAtMostFourSignificantDigitsBeforeTrailingZeroes(value: number): boolean {
  if (value === 0) {
    return true;
  }

  const trimmedDigits = value.toString().replace(/0+$/, "");
  return trimmedDigits.length <= 4;
}
