export function register(app: any) {
  // stub: will register POST /ingest in future
  // For now just expose a placeholder handler if desired
  app.get("/ingest", (c: any) => c.json({ ok: true, note: "ingest stub" }));
}
