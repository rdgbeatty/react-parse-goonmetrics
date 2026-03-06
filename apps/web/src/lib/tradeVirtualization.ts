export type VirtualWindow = {
  startIndex: number;
  endIndex: number;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
};

export function getVirtualWindow(
  itemCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan: number,
): VirtualWindow {
  if (itemCount <= 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
    };
  }

  const visibleRowCount = Math.max(1, Math.ceil(viewportHeight / rowHeight));
  const firstVisibleIndex = clamp(Math.floor(scrollTop / rowHeight), 0, itemCount - 1);
  const startIndex = Math.max(0, firstVisibleIndex - overscan);
  const endIndex = Math.min(itemCount, firstVisibleIndex + visibleRowCount + overscan);
  const topSpacerHeight = startIndex * rowHeight;
  const bottomSpacerHeight = Math.max(0, (itemCount - endIndex) * rowHeight);

  return {
    startIndex,
    endIndex,
    topSpacerHeight,
    bottomSpacerHeight,
  };
}

export function getWindowVirtualWindow(
  itemCount: number,
  windowScrollY: number,
  viewportHeight: number,
  bodyTop: number,
  rowHeight: number,
  overscan: number,
): VirtualWindow {
  const viewportBottom = windowScrollY + viewportHeight;
  const relativeScrollTop = Math.max(0, windowScrollY - bodyTop);
  const visibleBodyHeight = viewportBottom <= bodyTop
    ? rowHeight
    : viewportBottom - Math.max(windowScrollY, bodyTop);

  return getVirtualWindow(
    itemCount,
    relativeScrollTop,
    Math.max(rowHeight, visibleBodyHeight),
    rowHeight,
    overscan,
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
