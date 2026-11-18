# Storage and whole-processing-pipeline benchmark

This is a local, post-download pipeline benchmark. It starts from ESI-shaped JSON and the installed SDE catalog and ends with a durably written customer JSON file. It charges parsing, normalization, order aggregation, format conversion, persistence, restore/query, history summaries and publication. It does **not** time the internet, SSO, CCP cache delays or GitHub artifact services.

Run from WSL/Linux with the already available Node 18+, Python 3.12/SQLite 3.45+ JSONB support, GNU dbm and GCC. These are benchmark tools, not new application dependencies. No packages are installed by this command.

```text
npm run backend:benchmark -- --types=100 --repeats=1
npm run backend:benchmark -- --types=20000 --source-days=24 --repeats=3 --output=docs/discovery/benchmarks/storage-linux-2026-11-07.json
```

The small run checks semantic equality; it is not a useful large-data timing estimate. `--modes` selects a comma-separated subset. `--work-dir` changes the filesystem under test. Default temporary files are on Linux `/tmp`, avoiding the Windows-mounted repository filesystem as an accidental SQLite/fsync penalty.

## Workloads

1. **Bootstrap:** parse catalog, raw orders and daily-history responses; normalize/reduce; persist; compute summaries; publish JSON.
2. **Prices:** fresh process; restore catalog and cached summaries; parse/reduce a complete order refresh; replace only current quote data; publish JSON. Split-file candidates do not read/rewrite retained daily history here.
3. **History:** fresh process; parse the following day's overlapping responses; correct the recent three days, trim to 21 days and recompute 7/14-day summaries; retain current quotes and publish JSON. SQLite uses keyed upserts that avoid rewriting unchanged daily rows.

The large profile has 20,000 selected types × three hubs/regions, up to 1.26 million retained daily rows and 60,000 quote rows. Available legacy cached order pages supply real replay rows; missing type/hub pairs and missing catalog types are filled synthetically to reach the stress size. The report records those counts. Daily history is deterministic synthetic data with stable missing-date gaps and corrections. Raw input fixtures are temporary and removed at completion. They are never a market-order history store.

`--source-days=24` tests a source window larger than retention. ESI cannot be asked for only 24 days: actual responses can contain a longer available history. `--source-days=365` permits that sensitivity test; large profiles allocate substantial memory because these reference readers parse the coalesced replay input eagerly. Live per-response streaming can lower memory and changes allocation costs. Do not report fixture sizes as measured live ESI coverage.

The recorded main run replayed legacy cached pages before those pages were deliberately purged. Future runs fall back to synthetic order fill when no raw pages exist, or use whatever eligible replay input is locally available. Compare report input counts/provenance before comparing timings; the procedure is reusable but does not retain old raw books solely to reproduce a historical timing.

## Candidates

| Candidate | Representation/processor |
| --- | --- |
| `node-object-json` | Named-field JSON rows, converted to/from the common column layout. Measures layout-adapter cost too; it is not a claim that all object-based applications require these conversions. |
| `node-json` | Compact JSON row arrays, processed in JavaScript. |
| `node-v8` | The same arrays in Node's V8 binary serialization. |
| `node-c-binary` | Node parses/normalizes ESI JSON and writes LE float64 tables; compiled C reads them, aggregates history and writes customer JSON. Both processes are charged, including conversion and child startup. |
| `python-json` | Runtime control for interpreting SQLite/document-store comparisons. |
| `python-sqlite` | Relational tables, typed keys, indexed history, transactions and SQL aggregation. |
| `python-jsondoc` | Indexed SQLite JSON-text documents; one history document per region/type, traversed using JSON1. |
| `python-jsonb` | The same document model stored/traversed as SQLite JSONB. |
| `python-dbm` | GNU dbm indexed JSON documents, one history document per region/type. |
| `python-jsondoc-rowid` / `python-jsonb-rowid` | SQLite document-layout controls using ordinary rowid tables for the larger documents, rather than the initial WITHOUT ROWID layout. |

SQLite JSON/JSONB and GNU dbm JSON are actual embedded document-store tests, not conclusions about uninstalled TinyDB/LokiJS/LMDB/RocksDB/DuckDB. Third-party engines and a direct Go/C JSON decoder remain unmeasured alternatives. The native candidate deliberately uses an explicit Node JSON adapter so no conversion cost disappears from the experiment. Its format is benchmark-only; a production binary format would need a version/integrity/migration specification.

All candidates publish the same reference column-oriented JSON, validated by semantic comparison outside measured work. This is a benchmark contract, not an automatic replacement of the existing viewer schema. Null missing-day summaries, numbers and Unicode names must match. No raw orders are in the persisted benchmark state or output.

## Measurement and limits

- Three independent repetitions by default; deterministic randomized candidate order; fresh interpreter per job.
- External Linux `wait4` measures user+system CPU, including waited-for C children, and wall time including startup.
- Peak RSS is the maximum process RSS, not the sum of simultaneously resident parent/child processes. Source replay and representation conversion affect peak memory.
- File candidates use temp-write, file fsync and atomic rename. SQLite uses DELETE journaling and FULL synchronous transactions; dbm syncs. No database durability setting is disabled to win a timing.
- Native compiler time is recorded separately. Include it in a fresh Actions-job estimate unless the compiled helper is restored separately.
- A separate gzip-level-1 measurement records state packaging CPU/bytes and the logical price-only restore footprint. It is a proxy, not an Actions zstd upload/download measurement.
- Single-file databases contain retained history even when price jobs query only summaries. Splitting serving/history databases is an architectural alternative; query timings alone do not price the artifact restore.
- OS page caches are not flushed. Results are local WSL/Linux measurements; report medians/ranges and remeasure on Actions before forecasting savings.

The SDE's HTTP byte ranges select a **ZIP member**, not JSON syntax. Changing the internal state format does not change the bytes in CCP's ZIP. SDE downloading/decompression is a shared, infrequent upstream step and is excluded; parsing the installed catalog is included.

Measured results and the current recommendation are in [the performance report](../../../docs/discovery/07-storage-performance.md). The main report covers the original nine modes; the two rowid document layouts have a separate three-repetition report using the identical main fixture. The 365-source-day sensitivity profile is also separate and uses one repetition.

## Implemented history lifecycle benchmark

The separate command `npm run backend:benchmark:history` exercises the actual retained-history implementation, rather than the storage candidates above. It runs cold backfill, same-day cache reuse, next-day upserts/corrections and local integrity verification, each in a fresh process. It replays 402-record HTTP bodies across 20,000 types × three regions, retains 21 daily records, publishes the real viewer contract, and records CPU/wall/RSS, decoded source bytes, checkpoint bytes and final footprint.

Use `-- --types=100 --repeats=1` for a quick check. Full results and caveats are in [the lifecycle report](../../../docs/discovery/08-history-lifecycle.md). No ESI bulk requests or package installations occur. Source/checkpoint/publication work is timed; final gzip/footprint inspection is separate.
