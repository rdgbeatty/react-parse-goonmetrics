# EVE market migration discovery

Research date: **2026-11-06**. Repository baseline: `7ee5957d60feebd095823c3a4a16a55ccbd3d7a0`.

This package records the existing system, upstream capabilities, architecture alternatives and the locally authorized backend implementation. GitHub publication and hosted migration remain deferred.

**2026-11-16 update:** Tortuga/Siseide has been removed. Live collection now defaults to Jita and C-J6MT, with configurable optional future hubs. [Document 10](10-jita-cj-deployment-and-dormancy.md) supersedes earlier hub and deployment assumptions.

**2026-11-17 update:** [Document 11](11-github-only-auth-feasibility.md) records successful real-browser API-access checks, the local static PKCE sign-in harness, and a GitHub-only credential/workflow design. The integrated hosted flow remains to be proven.

**2026-11-18 implementation:** [Document 12](12-combined-release.md) records the combined old/new release, encrypted hosted setup, manual workflows and local validation. [Deployment guide](../deployment.md).

## Read in this order

1. [EVE API, character authorization, and market-data limitations](01-eve-api-and-authentication.md)
2. [Repository architecture and hosting assessment](02-architecture-and-hosting.md)
3. [Migration plan, local testing, and single-command operation](03-migration-and-local-testing.md)
4. [GitHub-only snapshots versus Cloudflare, using the clarified workload](04-github-only-vs-cloudflare.md)
5. [Local proof: implemented decisions, alternatives and validation](05-local-proof-decisions.md)
6. [Backend scaffold: catalog pipeline and data-model discussion](06-backend-data-model.md)
7. [Storage pipeline performance measurements and decision](07-storage-performance.md)
8. [Persistent history lifecycle, table-first viewer, metrics and decisions](08-history-lifecycle.md)
9. [Live history-pull diagnosis, automatic batches and visible deferrals](09-history-pull-diagnosis.md)
10. [Jita/C-J6MT closeout, GitHub Actions/credentials and dormancy](10-jita-cj-deployment-and-dormancy.md)
11. [GitHub-only browser sign-in feasibility, Secrets and workflow design](11-github-only-auth-feasibility.md)
12. [Combined release, implemented GitHub lifecycle and integration tests](12-combined-release.md)

[Project TODOs](../../TODO.md) track remaining implementation, validation, GitHub and frontend work.

The local concept has been proven and promoted to a backend scaffold. Run `npm run backend:catalog`, then `npm run backend` from the repository root. See the [run guide](../../apps/market-backend/README.md). No dependency installation is required. The owner has confirmed real PKCE login and private-structure collection; the official SDE catalog import and unchanged-version check have also succeeded. Document 6 records the data-model discussion; document 8 describes the implemented lifecycle and viewer.

**Current recommendation:** document 4 updates the earlier Cloudflare-first experiment. Public snapshots, one owner character, hourly-to-eight-hour refreshes and latest-only storage make GitHub Actions + Pages the first prototype to evaluate. The backend/database design in documents 2–3 remains an alternative if additional requirements justify it.

## Requirements confirmed during discovery

- Add **Tortuga**, a player-owned market structure in **Siseide**. Its identity and access have been verified during local collection.
- Retain the **C-J6MT** hub, which also requires character-authorized access.
- Continue comparing those hubs with Jita, including import/export profitability, transport costs, and filler scoring.
- Prefer **$0 ongoing hosting**, accepting delayed refreshes and free-tier limits.
- Test locally before committing to a replacement stack. Starting and deploying the eventual solution must each be possible through one script or button after initial account/credential setup.
- Approximately 20,000 small rows per hub, or 60,000 across the three hubs. The owner reports tens of milliseconds for the measured 20,000-row ingest path; end-to-end ESI collection is still to be measured.
- Hourly refresh preferred; six/eight hours acceptable. Only the current market snapshot is required, with optional reusable regional-history summaries.
- The owner's single character can collect both private hubs, and **public distribution of the resulting market snapshots is acceptable**. Visitors do not need their own EVE grants for this version.

## Main findings

- EVE SSO is the right way to obtain character access. The developer registers an application; a character grants scopes through OAuth. There is no character API key to ask users to paste. Both private hubs need an authorized collector character with structure access. Public Jita data does not require that grant. See [the API guide](01-eve-api-and-authentication.md).
- The current monorepo, React UI, Hono routes, and pure calculation helpers can be retained. Replace the data acquisition and persistence boundaries, and remove fixed Jita/C-J6MT fields from the new contract. A wholesale UI rewrite is unnecessary for this requirement. This is an architectural recommendation based on [the source inventory](02-architecture-and-hosting.md#repository-evidence).
- ESI regional history cannot supply exact Tortuga or C-J6MT weekly sales. Price comparisons can ship before a trustworthy demand estimate; unavailable volume must remain unavailable, rather than becoming zero or an unlabeled regional number. See [metric provenance](01-eve-api-and-authentication.md#replacing-the-scraped-fields).
- **Do not choose Deno Deploy for the replacement.** Deno's October 9, 2026 announcement says Deploy will operate for six more months before shutdown, with Deno-team runtime development ending after another year. Those imply approximately April and October 2027, respectively; they are inferred windows, not separately announced shutdown dates. The runtime remains open source. [Deno announcement](https://deno.com/blog/cloudflare).
- Under the clarified requirements, the preferred experiment is **GitHub Actions collecting ESI and publishing generated JSON in the Pages artifact beside the React app**, without committing market snapshots. A permanent API/database is optional. Compare against Cloudflare static publishing on equal requirements, and prove durable refresh-token handling before calling either unattended. See [the updated comparison](04-github-only-vs-cloudflare.md).

## Decisions still needed

| Decision | Proposed default / experiment |
| --- | --- |
| Exact hub identity | Obtain Tortuga's structure ID when available. Verify the legacy C-J6MT candidate `1049588174021` using an authorized character; the URL alone does not prove it is still the correct structure. |
| Collector identity / token persistence | One owner's character is confirmed to access both hubs. Choose and prove secret write-back or encrypted Git state for replacement refresh tokens. |
| Who can view collected structure data | Confirmed: public market snapshots are acceptable. Keep all EVE credentials out of the public payload. |
| Meaning of “buy/sell” | Configure acquisition and sale strategies independently. Preserve current behavior as a named legacy strategy for comparisons. |
| Demand / weekly volume | Initially show unknown for hub sales; offer regional seven-day volume only as a labeled reference. Validate any estimated hub turnover separately. |
| Hosting selection | Run the GitHub-only experiment in document 4; compare simpler Cloudflare static publishing if needed. Documents 2–3 retain the larger backend alternative. No provider resources are provisioned by these docs. |

## Research boundaries

Source files and the tracked deployment workflow were inspected. Current vendor and EVE documentation were researched. The public ESI OpenAPI specification was downloaded and inspected with `X-Compatibility-Date: 2026-11-05`; the server returned schema version `2026-08-18`. Its SHA-256 was `9a9a0f4af77216300e960cfd2576c9baac085a8170022e40c928c28622d80fc6`. The download is an inspection aid, not a new runtime dependency or a vendored contract.

No character tokens, private market books, hosting-account settings, deployed health checks, or Goonmetrics database internals were inspected. In particular, the user's description of Goonmetrics' ingestion/database is background context, not independently verified behavior. The source repository establishes the scraping behavior documented here.

The available local environment has Node `18.19.1`, npm `9.2.0`, and Docker Compose `v5.5.0`; it has no `deno`, `pnpm`, or installed workspace dependencies. The initial documentation work did not run the original application's tests/build. The subsequent dependency-free backend passed its own automated and browser checks, recorded in [document 5](05-local-proof-decisions.md) and [document 6](06-backend-data-model.md). Real EVE authorization has been confirmed locally; hosted deployment remains unverified. Documentation links and repository references are checked separately.

Pricing and product status are time-sensitive. Recheck the linked official pages at implementation time, especially Deno's retirement, newer Neon backend features, and free-plan limits.
