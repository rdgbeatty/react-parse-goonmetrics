export function register(app: any) {
  // stub: will register GET /items in future
  app.get("/items", (c: any) => c.json({ ok: true, items: [] }));
}
