import { getVirtualWindow, getWindowVirtualWindow } from "./tradeVirtualization.ts";

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, received ${actual}`);
  }
}

Deno.test("getVirtualWindow returns a bounded window near the top", () => {
  const result = getVirtualWindow(1000, 0, 380, 38, 5);

  assertEqual(result.startIndex, 0, "top window should start at zero");
  assertEqual(result.endIndex, 15, "top window should include visible rows plus overscan");
  assertEqual(result.topSpacerHeight, 0, "top spacer should be zero at the top");
  assertEqual(result.bottomSpacerHeight, (1000 - 15) * 38, "bottom spacer should preserve remaining height");
});

Deno.test("getVirtualWindow returns a centered window in the middle of the list", () => {
  const result = getVirtualWindow(1000, 3800, 380, 38, 5);

  assertEqual(result.startIndex, 95, "middle window should include overscan above");
  assertEqual(result.endIndex, 115, "middle window should include visible rows plus overscan below");
  assertEqual(result.topSpacerHeight, 95 * 38, "top spacer should match skipped rows");
  assertEqual(result.bottomSpacerHeight, (1000 - 115) * 38, "bottom spacer should match remaining rows");
});

Deno.test("getVirtualWindow clamps the end of the list", () => {
  const result = getVirtualWindow(50, 99999, 380, 38, 5);

  assertEqual(result.startIndex, 44, "late window should still keep overscan above when possible");
  assertEqual(result.endIndex, 50, "late window should clamp to item count");
  assertEqual(result.bottomSpacerHeight, 0, "bottom spacer should disappear at the end");
});

Deno.test("getWindowVirtualWindow anchors to the top of the table body before it enters view", () => {
  const result = getWindowVirtualWindow(1000, 0, 800, 1200, 38, 5);

  assertEqual(result.startIndex, 0, "offscreen tables should keep the first rows ready");
  assertEqual(result.endIndex, 6, "offscreen tables should render a small initial window");
});

Deno.test("getWindowVirtualWindow uses page scroll once the table body is on screen", () => {
  const result = getWindowVirtualWindow(1000, 1600, 800, 1200, 38, 5);

  assertEqual(result.startIndex, 5, "window scroll should translate into row offset from the body top");
  assertEqual(result.endIndex, 37, "window scroll should include a full viewport of rows plus overscan");
});
