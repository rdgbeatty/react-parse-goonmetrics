# First GitHub Pages publication

Date: **2026-11-18**. The owner accepted the local release and authorized commit, push, state seeding and publication. Both sites are live.

- [Original live-scraper site](https://rdgbeatty.github.io/react-parse-goonmetrics/)
- [New EVE market viewer](https://rdgbeatty.github.io/react-parse-goonmetrics/market/)
- [Collector owner setup](https://rdgbeatty.github.io/react-parse-goonmetrics/market/connect.html)
- [Successful first publication run](https://github.com/rdgbeatty/react-parse-goonmetrics/actions/runs/44399810675)
- [Nonsecret state release](https://github.com/rdgbeatty/react-parse-goonmetrics/releases/tag/market-state)

## Source and publication

Release commit `9b98d45955a50364090745dc9884d766cb27ea31` contains the reviewed scaffold, combined release and manual workflows. GitHub rejected its two workflow files because `runner.temp` is unavailable in job-level `env`. Fix `1027574d2657b8b15aba417c74dad0cbb8f61a07` initializes the state path in a runner-executed step through `GITHUB_ENV`; that revision produced the successful first deployment.

The GitHub run completed at **21:17:36 UTC**. The build job took **23 seconds** and deployment **14 seconds**, with about **46 seconds** from run start to completion. The hosted Node 24 runner restored the state release, passed **96 backend tests** and **14 legacy library tests**, built both sites and deployed one Pages artifact. These are publication/restore timings, not EVE ingestion benchmarks.

## Data seed and live checks

The initial public state archive is **8,040,930 bytes**, containing validated catalog, retained regional history and the public snapshot. Its upload was downloaded again and checked before success. It contains no character grant, application secret, GitHub token, private configuration or raw order-book cache.

The published snapshot was generated **2026-11-16T17:47:26.544Z** and has **19,258 rows each for Jita and C-J6MT**. Tortuga remains disabled. Publication does not make those observations fresh: the viewer preserves their actual quote timestamps and age.

Live HTTPS checks returned 200 for the original/new viewer, static callback, public config, operations guide and release manifest. The served JSON passed the shared snapshot validator. Installed Chrome verified that the original site still fetches live scraper rows, the modern viewer renders the full dataset, navigation points between the two sites and owner setup displays the exact production callback.

## Credential preparation and remaining integration

The `market-collector` environment exists and is restricted to the `main` branch. A temporary noncredential Secret verified real GitHub public-key retrieval, LibSodium encryption, Secret creation and metadata lookup; it was immediately deleted. No EVE grant or GitHub login credential was copied into Secrets. The terminal's existing GitHub sign-in was used for the approved repository/release/deployment operations only.

Before the first authenticated collection:

1. Register the exact production EVE callback displayed by owner setup. A separate production registration can preserve local use; update the public client ID consistently if using one.
2. Configure `MARKET_WRITER_TOKEN` with repository-limited Environments read/write permission, or the documented GitHub App writer credentials.
3. Connect EVE through the published owner page and supply temporary owner GitHub authorization for encrypted staging/adoption.
4. Verify successful adoption, then run Resume / refresh markets and inspect actual quote collection, replacement-grant persistence and history checkpoint metrics.

Real EVE browser sign-in on the published callback, authenticated hosted collection, queued grant rotation and failure recovery are not established by the publication test. [Deployment/recovery procedure](../deployment.md).

Both workflows remain **manual-only**, with no schedules or push-triggered collection. The old Deno backend remains the independent live fallback during transition. The seeded site can keep serving its dated snapshot while dormant.
