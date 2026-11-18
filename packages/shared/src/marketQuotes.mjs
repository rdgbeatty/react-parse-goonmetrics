// Current-book reduction only: no order IDs, individual prices, sellers or order history persist.
export function aggregateOrders(orders, asOf = new Date().toISOString()) {
  const end = Date.parse(asOf);
  if (!Number.isFinite(end)) throw new Error("Invalid competition observation time.");
  const quotes = Object.create(null);
  for (const order of orders) {
    if (!order.volume_remain) continue;
    const key = String(order.type_id);
    const quote = quotes[key] ??= { bid: null, ask: null, buyUnits: 0, sellUnits: 0,
      competition: { askOrders: 0, recentAskOrders24h: 0, recentAskUnits24h: 0, recentAskOriginalUnits24h: 0, unknownIssuedAskOrders: 0 } };
    if (order.is_buy_order) {
      quote.bid = quote.bid === null ? order.price : Math.max(quote.bid, order.price);
      quote.buyUnits += order.volume_remain;
    } else {
      quote.ask = quote.ask === null ? order.price : Math.min(quote.ask, order.price);
      quote.sellUnits += order.volume_remain;
      const competition = quote.competition; competition.askOrders++;
      const issued = Date.parse(order.issued), age = end - issued;
      if (!Number.isFinite(issued) || age < 0) competition.unknownIssuedAskOrders++;
      else if (age <= 86_400_000) {
        competition.recentAskOrders24h++; competition.recentAskUnits24h += order.volume_remain;
        if (Number.isSafeInteger(order.volume_total) && order.volume_total >= 0 && competition.recentAskOriginalUnits24h !== null) competition.recentAskOriginalUnits24h += order.volume_total;
        else competition.recentAskOriginalUnits24h = null;
      }
    }
  }
  for (const quote of Object.values(quotes)) {
    if (quote.competition.unknownIssuedAskOrders) {
      quote.competition.recentAskOrders24h = null; quote.competition.recentAskUnits24h = null; quote.competition.recentAskOriginalUnits24h = null;
    }
  }
  return quotes;
}

export function validateBookSummary(book) {
  const envelope = ["schemaVersion", "observedAt", "expiresAt", "competitionAsOf", "competitionWindowHours", "pageCount", "orderCount", "quotes"];
  const competitionKeys = ["askOrders", "recentAskOrders24h", "recentAskUnits24h", "recentAskOriginalUnits24h", "unknownIssuedAskOrders"];
  if (!book || book.schemaVersion !== 1 || Object.keys(book).some((key) => !envelope.includes(key)) ||
    ![book.observedAt, book.competitionAsOf].every((time) => Number.isFinite(Date.parse(time))) ||
    !Number.isFinite(book.expiresAt) || book.competitionWindowHours !== 24 || !Number.isInteger(book.pageCount) || book.pageCount < 1 ||
    !Number.isSafeInteger(book.orderCount) || book.orderCount < 0 || !book.quotes || Array.isArray(book.quotes)) throw new Error("Invalid aggregate order-book cache.");
  for (const [typeId, row] of Object.entries(book.quotes)) {
    if (!/^[1-9]\d*$/.test(typeId) || !row || Object.keys(row).some((key) => !["bid", "ask", "buyUnits", "sellUnits", "competition"].includes(key)) ||
      ![row.bid, row.ask].every((price) => price === null || typeof price === "number" && Number.isFinite(price) && price > 0) ||
      ![row.buyUnits, row.sellUnits].every((units) => Number.isSafeInteger(units) && units >= 0) || !row.competition ||
      Object.keys(row.competition).some((key) => !competitionKeys.includes(key))) throw new Error("Invalid aggregate quote row.");
    for (const key of competitionKeys) {
      const value = row.competition[key];
      if (!(value === null && key.startsWith("recent") || Number.isSafeInteger(value) && value >= 0)) throw new Error("Invalid competition aggregate.");
    }
  }
  return book;
}
