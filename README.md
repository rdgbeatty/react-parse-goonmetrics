# gm-scraper

Combined release: after `npm ci`, run **`npm start`** and open the printed localhost URL. The original React site stays at the root; the new EVE market viewer is under `market/`, with navigation between them and separate CSS. Nothing uploads automatically. See the [deployment/setup/recovery guide](docs/deployment.md) and [implementation decisions and validation](docs/discovery/12-combined-release.md).


Local market backend scaffold: run `npm run backend:catalog` once, then `npm run backend` (Node 18+, no package install). Open http://localhost:4173. See the [run guide](apps/market-backend/README.md) and [data model discussion](docs/discovery/06-backend-data-model.md). Existing `poc:*` commands remain compatible. The viewer now has a table-first Browse page and separate setup/metrics page, plus resumable 21-day history (`npm run backend:history`). See [history lifecycle](docs/discovery/08-history-lifecycle.md). Track remaining work in [TODO.md](TODO.md); see the [storage benchmarks](docs/discovery/07-storage-performance.md).

For the EVE API migration background, Start with the [discovery documentation](docs/discovery/README.md) for character authorization, Jita/C-J6MT and configurable future-hub support, hosting options, and the local testing/migration plan.

Monorepo with a Deno 2 backend (Hono) and a Vite + React frontend. A shared TypeScript package provides Zod schemas/types consumable by both runtime targets.

Quickstart

1. Install workspace deps:

   npm ci

2. In one terminal start the API (Deno must be installed):

   deno task dev --cwd apps/api

   The API listens on http://localhost:4000 and exposes GET /health returning { ok: true }.

3. In another terminal start the web app:

   npm run dev --workspace=@gm/web

   Vite will run on http://localhost:5173 by default.

Notes

- The API uses Deno and an import map that points `@gm/shared` to `packages/shared/src`.
- The web app resolves `@gm/shared` to the same source folder via Vite alias and TS paths.
- Prisma folder is a placeholder; no DB logic yet.




Setup Instructions:

1) Run the following commands to install node.js on Windows (Does not require admin access):
```
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
iwr -useb get.scoop.sh | iex
scoop install nodejs
```

2) Install the VSCode Deno plugin