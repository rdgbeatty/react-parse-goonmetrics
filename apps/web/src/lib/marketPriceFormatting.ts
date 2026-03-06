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
  return Number.isFinite(value) && Number.isInteger(value);
}
