# Combined release and collector operations

This release keeps the original React site at `/react-parse-goonmetrics/` (including its hash routes) and the new market viewer at `/react-parse-goonmetrics/market/`. Each is a separate HTML document and CSS bundle. The original site keeps its live Deno scraping API during transition. The new site's market collection, state and authentication run entirely through GitHub.

## Local review before uploading

Install approved dependencies once with `npm ci` in the same terminal environment you will use to run the app. Windows and WSL need their own platform-specific native build dependencies; if switching between them, rerun `npm ci` there. The agent validated the build/tests under WSL and the pages in Windows Chrome. Then run:

```
npm start
```

Open the printed localhost address. It builds and serves both sites with the actual GitHub project subpath. Existing live local data is included when present; simulated data is rejected unless `--allow-fixture` is explicitly supplied for local QA. A clean checkout with no snapshot still builds both sites and owner setup; the new viewer explains that collection is needed. No collection, upload or GitHub change occurs automatically.

The original site calls the configured live Deno API, including its original 5-minute / 1-hour scraper caches. `npm run backend` remains the separate local EVE collector UI. Stop one server before starting another on port 4173, or use `npm start -- --port=4174`. The separate proof command `npm run backend:github-check` still tests browser-only PKCE on the previously registered local callback.

Checks: `npm run backend:test`, `npm run test:legacy`, `npm run release:build`. The original Deno test commands also remain available. `npm run release:preview` serves the already built artifact. The deployment workflow uses npm and package-lock.json. pnpm-lock.yaml is retained for the old development workflow, but is not the release lockfile.

## Public configuration

Keep the configured repository/default branch/environment and workflow settings in sync. Review `config/market.json`: repository owner/name, default branch, EVE application client ID, approved collector character ID, C-J6MT structure ID, optional future hubs, ESI contact URL and legacy API origin. These are intentionally public. Never put an EVE application secret, refresh token, GitHub token or App private key in this file. Unknown top-level fields are rejected before publication.

The new app uses browser PKCE; an EVE application secret is unnecessary. Register the exact production callback printed by Owner setup:

`https://rdgbeatty.github.io/react-parse-goonmetrics/market/connect.html`

A separate EVE application registration can preserve the existing local callback. If you use one registration and change its callback, update its public client ID/callback consistently and reconnect. Existing authorizations from another application cannot be silently reused.

## Initial GitHub setup

1. Review/commit/push the complete code after local acceptance. No source push or deployment is performed by local start/build commands.
2. In repository Settings → Environments, create `market-collector`, restrict it to the configured default branch, and configure its writer credentials below. This is a Secrets/settings group, not another hosted server.
3. In Settings → Pages, choose GitHub Actions as the build source. The existing `github-pages` deployment environment should permit the default branch.
4. Recommended for the first release: preserve the already-collected local dataset with `npm run release:seed -- --dry-run`, then `npm run release:seed`. The latter uploads only the validated nonsecret archive to a new state release and prompts for a repository-scoped owner token with **Contents: read/write** (hidden input). It refuses to overwrite an existing hosted state release and includes no grant/config/private caches. Revoke a separate seed token after use. Do this only after accepting the local build; it is an upload. Then run **Publish both sites** manually from Actions. If seeding was skipped, no state release is normal: the original site and owner setup publish while new market data remains unavailable. With seeding, the new viewer initially shows the same dated local dataset you reviewed. The current legacy deployment stays online until the replacement artifact successfully deploys.
5. Open the new site's Owner setup, authorize EVE, then supply an owner GitHub token. Saving encrypts `EVE_PENDING_GRANT` and dispatches **Market collector → adopt**. Check that run's success; pending is not yet connected.
6. Run **Resume / refresh markets**. It updates the catalog, preserves the refreshed grant, collects both active hubs, runs one bounded history batch, checkpoints state and deploys both sites. Continue history batches as needed. Schedules remain off.

The configured owner account is required for hosted operations; organization/multiple-administrator support is not included. Workflow guards check repository/default branch/owner and all release/collector workflows share one non-cancelling concurrency group. GitHub concurrency is not a durable FIFO queue: repeated clicks can replace pending runs. Do not dispatch repeatedly to build a backfill queue.

## Writer credentials: choose one

Simplest: create a fine-grained personal token limited to this repository, with **Environments: read/write**. Store it as the `MARKET_WRITER_TOKEN` environment Secret. It lets Actions save replacement EVE grants. Track its expiration and renew it before resuming after dormancy. No Contents or Actions permission is needed on this writer token.

Alternative: register a GitHub App with **Environments: read/write**, install it only on this repository, and store these environment Secrets:

- `MARKET_APP_ID`: numeric App ID.
- `MARKET_APP_INSTALLATION_ID`: numeric installation ID.
- `MARKET_APP_PRIVATE_KEY`: downloaded private key PEM.

The collector signs an App JWT and obtains a short-lived token scoped to this repository. No external App server or webhook is needed. Use one writer method; a configured personal writer token takes precedence.

For the browser's owner setup token, grant **Environments: read/write** plus **Actions: read/write** on this repository. Paste it only into Owner setup. It is never persisted in local/session storage, source or workflow inputs; it is cleared after a successful dispatch. You can revoke a separate setup token after use. The unattended writer must remain authorized. Secret-management permission covers the environment's Secrets, not just one named key.

## Credential lifecycle and reconnection

The canonical grant is `EVE_GRANT` in the collector environment. Jobs load environment Secrets at job start, after serialization, to avoid repository Secrets' queue-time snapshot behavior. Initial setup uses an encrypted pending grant plus a nonsecret random nonce. Adoption checks nonce age/repository/application and verifies the signed EVE identity/scopes before changing the canonical Secret. A different character is rejected. The canonical grant records the adopted setup nonce, making repeated dispatches idempotent. Pending setup is not automatically deleted: a newer browser login may replace it while a job is running. Its private value is ignored by normal runs and overwritten on the next setup; an owner can remove it manually when setup is finished. Adoption requires the pending setup to be less than 24 hours old.

Normal refreshes write replacements immediately before ESI/validation work can fail. Replacement token values are masked explicitly. A failure between EVE issuing a replacement and GitHub saving it cannot be made atomic; reconnect if necessary. A Secret write failure stops collection. Local grant files are not automatically synchronized with the hosted canonical grant.

For reconnecting: use Owner setup again, wait for successful adoption, then run collection. If saving succeeded but dispatch failed, retry pending setup from the same tab. After closing/reloading that tab, start a new connection. Do not paste plaintext tokens into Actions inputs, issues or logs. Disconnect/revocation upstream is handled in EVE account application settings; forgetting browser credentials does not revoke the hosted grant.

## State, failure and recovery

Generated data is not committed. The `market-state` prerelease holds up to three retained generation assets after successful deployment. Each is a gzip JSON archive with an explicit file allowlist, per-file checksums and repository/schema metadata. This checkpoint release must permit mutable assets; release immutability is detected and rejected. It contains catalog, retained 21-day regional history/checkpoints/session state, derived summaries and the public snapshot. It excludes private files, grants, raw order books and arbitrary caches. Release assets in this public repository are public.

Restore validates all entries before writing, rejects paths outside the allowlist and rejects symlinks/credential fields. It restores the newest uploaded generation; corruption stops the job rather than silently rolling history backwards. Repair/remove a corrupt newest asset deliberately, or remove the state release to trigger a documented cold rebuild. Never restore unreviewed files over a local private directory.

Quotes publish independently of incomplete/failed history. Each manual run is bounded to one 1,000-request / five-minute history batch, with ESI expiry, corrections, 24-hour item deferrals and retained checkpoints. A later batch resumes through freshness checks; it does not require a multi-hour Action. HTTP retries count toward history's budget. A failed run can still save completed state; it does not deploy a failed publication. Hard cancellation may lose work since the last saved release checkpoint.

Catalog updates share the existing updater. A missing cache/state rebuilds from CCP; a missing grant requires reconnecting. Required C-J6MT failures leave the last published site intact. Optional retired/future hubs may be omitted according to configuration. Restored snapshots remain dated, including old history, until a successful refresh.

Both sites deploy in one Pages artifact, so navigation/assets cannot refer to different builds. A failed build/upload/deploy retains the prior Pages publication. For rollback, manually run Publish both sites on an approved code revision; its default-branch guard deliberately rejects arbitrary branch dispatch. For emergency legacy-only restoration, the former workflow is preserved in Git history, not as a second competing live deployer.

## Transition decisions and limitations

- Keep the original React UI/CSS and live Deno backend. A new navigation link is the only intended visual change. The new viewer is plain JavaScript, so a shared React rewrite would add coupling without helping this temporary integration.
- Use separate documents, root hash routes and `/market/`, packaged by one Vite/npm build. The local collector remains Node; the legacy Deno API remains independently deployed until removal.
- Do not scrape Goonmetrics periodically in Actions. Browser scraping was not adopted because cross-origin permission is controlled upstream; it is not a reliable fallback assumption.
- New market data never silently falls back to scraped rows. The original site remains an explicit user-selected fallback, preserving provenance and avoiding schema/metric mismatches.
- Manual workflows only. No push-triggered deployments or collection schedules are introduced.
- Installed legacy dependencies currently report audit advisories in Vite/esbuild, React Router and Zod. The combined release serves built static files rather than a Vite development server, uses fixed navigation links and performs no SSR. No force-upgrade was applied. Review/upgrade those dependencies separately; the original Deno API was not redeployed or audited by this task.
- Local/mocked verification cannot establish production callback registration, actual GitHub permissions, real queued Secret rotation or Pages delivery. The first live integration run remains an owner-assisted release step after local acceptance.
