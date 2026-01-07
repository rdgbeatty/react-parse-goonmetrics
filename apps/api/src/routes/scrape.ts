export function register(app: any) {
  // will register /scrape
  app.get("/api/scrape", async (c: any) => {
    const targetUrl = "https://www.w3schools.com/html/html_tables.asp";

    // fetch remote HTML
    const upstream = await fetch(targetUrl);
    if (!upstream.ok) {
      return c.text("Upstream fetch failed", 502, {
        "Access-Control-Allow-Origin": "*",
      });
    }

    const html = await upstream.text();

    // Return the HTML directly (frontend will parse it for now)
    return c.text(html, 200, {
      "Content-Type": "text/html; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
  });
}
/*
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  */