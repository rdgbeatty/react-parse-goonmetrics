# Combined release and GitHub collector implementation

Date: **2026-11-18**. Status: implemented and locally validated; no commit, push, Secret write or deployment has been performed. [Deployment and recovery guide](../deployment.md).

## Release architecture

The existing React/Vite application stays at the project root with its original hash routes, CSS, calculations and live Deno scraping API. Its new **EVE Markets** navigation tab performs a normal page navigation to `/market/`. The new viewer remains plain JavaScript with its own HTML/CSS, snapshot contract and **Original site** return link. Combining their output does not merge their component trees or global styles.

`npm start` builds and previews the complete Pages artifact using the real `/react-parse-goonmetrics/` subpath. `npm run backend` remains the standalone local collector. `npm run release:build` prepares `dist/`; neither command uploads anything. An optional first-release `release:seed` command uploads the validated local nonsecret state after owner acceptance, so the first deployment can show the dataset already reviewed locally. Its dry-run does not contact GitHub, and it refuses to overwrite an existing hosted state release. Production builds reject simulated data; a clean first release without any snapshot publishes the original site and owner setup, with an explicit unavailable-data message in the new viewer.

The old Deno backend was retained because live fallback behavior matters during transition. Direct probes returned HTTP 200 from its health endpoint, with browser access allowed. Goonmetrics itself returned HTML 200 without an Access-Control-Allow-Origin header for the Pages origin. Moving scraping into browser JavaScript is therefore not a supported assumption. Scraping was not moved to an Actions schedule. No Deno API code or deployment was changed.

## Implemented GitHub path

- Public configuration in `config/market.json`, validated against an explicit nonsecret field contract. The existing client ID, character ID and C-J6MT ID were copied without copying any application secret or refresh token. A public repository URL replaces personal ESI contact details in the hosted configuration.
- Browser PKCE authorization and signed EVE token verification, with the approved character checked before staging. The production callback is the real static file `/market/connect.html`.
- GitHub owner verification, LibSodium sealed-box encryption and environment Secret updates. Setup credentials remain in browser memory; only the temporary PKCE transaction uses session storage.
- A staged grant plus public nonce, followed by owner/default-branch-only adoption. Adoption verifies the refreshed EVE identity before changing the canonical grant. It is idempotent using the saved `setupNonce`.
- Pending Secrets are deliberately not deleted automatically: a newer browser login could replace the value while an older Action is validating. Normal runs ignore pending state; the next setup overwrites it, and manual deletion after setup is optional. A pending submission expires for adoption after 24 hours.
- Automatic replacement-grant write-back before local persistence/later collection. Either a separately stored fine-grained writer token or a GitHub App installation token is supported. Writer failures stop collection.
- Named environment Secrets load at job start; a shared workflow concurrency group coordinates adoption, collection and publication. Schedules and push triggers are absent.
- Two manual workflows: **Publish both sites**, and **Market collector** with adopt/resume/quotes/history/catalog operations. One bounded history batch is processed per collection/history run. Official Actions are pinned to verified commit IDs.
- Versioned `market-state` Release assets preserve nonsecret catalog/history/checkpoints/summaries/snapshot. A gzip JSON manifest avoids tar extraction. Paths, checksums, repository/schema, size limits, credential fields and symlinks are checked. The newest corrupt generation fails closed. Upload bytes are downloaded and verified before success; after a successful deployment, prune to three retained generations.

The existing Node collection/history/catalog code is reused. The initial owner GitHub token uses Environments and Actions permissions; the retained writer needs only Environments. A GitHub App requires no external server: its JWT signing/token request occurs inside Actions. Long-lived EVE credentials never enter workflow inputs, public build files or state archives.

## Decisions and alternatives

| Decision | Chosen implementation | Alternative considered |
| --- | --- | --- |
| Root address | Preserve original hash-route URLs; new site under `/market/` | New site at root with a relocated legacy app would break familiar URLs. |
| Frontend integration | Separate HTML documents/styles in one artifact | React consolidation or a full old-site rewrite adds coupling to a temporary fallback. |
| Legacy acquisition | Keep the working on-demand Deno endpoint | Browser scraping lacks upstream CORS; periodic Actions scraping conflicts with the requested live behavior. |
| Shared tools | npm workspace lockfile and Vite build, Node collector | Installing pnpm/Deno solely to package the release is unnecessary. Original development commands remain documented separately. |
| GitHub authority | Scoped token as simplest setup; optional App writer implemented | A button-only GitHub OAuth flow needs separate work and is not implied by REST CORS. |
| Setup coordination | Pending Secret + serialized/idempotent adoption; retain pending privately | Direct canonical browser writes can race with refresh; unconditional pending deletion can erase a newer setup. |
| Durable data | Verified versioned Release assets, three generations after deployment | Cache-only state is simpler but requires a cold rebuild after dormancy/eviction; data commits were avoided. |
| Source fallback | Explicit original-site tab | Automatically blending scraped and ESI rows would hide provenance and differences in market/history semantics. |
| First publication | Allow a clear no-snapshot state, forbid implicit fixtures | Uploading synthetic data as a live market would mislead users. |

## Validation

- All **96 backend tests** pass and cover existing 21-day history/optional hubs plus Secret encryption, owner guards, adoption, expiry/identity rejection, retries, durable rotation, App signing, archive security, release upload/restore and combined-build cold-start/rollback rules.
- All **14 original frontend library tests** pass using a Node/esbuild runner for the existing Deno.test-style files. Two stale shipping expectations used 1,200 ISK/m³ even though committed production code uses 700; only assertions were corrected, with no calculation change.
- Real Chrome integration passed **14 checks**: live legacy top500 and marketgroup imports/exports, navigation in both directions, visible cold-start messaging, isolated styles, full 19,258-item modern view, search/route swap, synthetic signed browser OAuth, actual browser-to-Node LibSodium encryption interoperability, no credentials in dispatch input/rendered text, and credential clearing/no persistent browser storage.
- The old All Items endpoint returned **19,654 rows** for both order types, taking **19.4 seconds** and **17.6 seconds** in direct probes. An initial ten-second browser QA timeout was too short; the larger wait passed. This was a test timing limit, not a frontend regression.
- Existing real catalog/history/snapshot: **104 files**, **8,040,930 compressed bytes**, **2,106 ms packing**, **2,158 ms restoration**, semantically identical restored snapshot. These are local measurements, not GitHub runner timings. Private files/caches/metrics were excluded.
- A completed combined artifact uses the existing live **2026-11-16** local snapshot; no new real EVE collection was started. Its age is shown in the viewer.
- Final review found and fixed a nested operation lock between the hosted runner and catalog updater. A regression now exercises the actual updater inside the hosted job, rather than replacing it with a mock. Standalone catalog CLI still acquires its own lock.
- A credential-free GitHub OPTIONS probe returned 204 and permitted the exact Secret PUT method and Authorization/Content-Type/X-GitHub-Api-Version headers used by the browser writer. No Secret write was made.
- Workflow YAML parsing and pinned Action commit IDs were checked. Actual GitHub workflow permissions/runtime, production EVE registration, queued-run behavior and Pages delivery still require the first live integration run.

`node scripts/browser-qa.mjs` provides the local-only synthetic browser test harness at localhost:4176/qa after a release build. It is excluded from the public artifact. The harness reads the live legacy endpoint but intercepts all EVE/GitHub authentication traffic with synthetic fixtures; it never writes remote Secrets. See normal test/build commands in the operations guide.

## Release prerequisites and remaining work

Before upload, the owner should inspect both sites locally with `npm start`. Then review the public config, register the production EVE callback (preferably using a separate production application to retain local operation), create the collector environment/writer, commit/push and run the manual publication workflow. Connect/adopt the character, run resume, and inspect a real collection/deployment before treating the hosted path as proven.

The approved install added `libsodium-wrappers@0.8.4` and existing workspace dependencies. The npm audit reports existing toolchain/library advisories in Vite/esbuild, React Router and Zod; details and the constrained runtime exposure are recorded in the operations guide. No forced major upgrade was made. The temporary Deno dependency, full live history catch-up, consecutive-day verification, UI refinements, dependency upgrades and real Actions timings remain tracked in TODO.md.
