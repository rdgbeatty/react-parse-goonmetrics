import { useEffect, useMemo, useState } from "react";
import { getWindowVirtualWindow } from "../lib/tradeVirtualization";

export function useWindowVirtualWindow(
  itemCount: number,
  bodyTop: number,
  viewportHeightFallback: number,
  rowHeight: number,
  overscan: number,
) {
  const [windowMetrics, setWindowMetrics] = useState(() => ({
    scrollY: 0,
    viewportHeight: viewportHeightFallback,
  }));

  useEffect(() => {
    const updateWindowMetrics = () => {
      setWindowMetrics({
        scrollY: window.scrollY,
        viewportHeight: window.innerHeight,
      });
    };

    updateWindowMetrics();
    window.addEventListener("scroll", updateWindowMetrics, { passive: true });
    window.addEventListener("resize", updateWindowMetrics);

    return () => {
      window.removeEventListener("scroll", updateWindowMetrics);
      window.removeEventListener("resize", updateWindowMetrics);
    };
  }, [viewportHeightFallback]);

  return useMemo(
    () =>
      getWindowVirtualWindow(
        itemCount,
        windowMetrics.scrollY,
        windowMetrics.viewportHeight,
        bodyTop,
        rowHeight,
        overscan,
      ),
    [bodyTop, itemCount, overscan, rowHeight, windowMetrics],
  );
}
