# gm-scraper

Monorepo with a Deno 2 backend (Hono) and a Vite + React frontend. A shared TypeScript package provides Zod schemas/types consumable by both runtime targets.

Quickstart

1. Install frontend deps:

   pnpm install

2. In one terminal start the API (Deno must be installed):

   deno task dev --cwd apps/api

   The API listens on http://localhost:4000 and exposes GET /health returning { ok: true }.

3. In another terminal start the web app:

   pnpm --filter @gm/web dev

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