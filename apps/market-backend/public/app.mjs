import { validateSnapshot, compareHubs, sortOpportunities, describeDataAge } from "./snapshot.mjs";

const HOSTED = document.querySelector('meta[name="market-mode"]')?.content === "hosted";
if (HOSTED) { document.getElementById("legacy-link").hidden = false; document.getElementById("hosted-panel").hidden = false; document.getElementById("deferred-panel").hidden = true; document.getElementById("metrics-download").hidden = true; document.getElementById("metrics-description").textContent = "Hosted run metrics and deferred-item progress are recorded in the collector Action logs."; document.getElementById("metrics-empty").textContent = "Open Owner setup & collection for the link to collector runs."; }
const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "long" });
const PAGE_SIZE = 100;
let lastQuotesRun, lastHistoryBatch;
let snapshot, derived = [], filtered = [], page = 0, sortKey = "estimatedWeekProfit", direction = "desc", localStatus, polling = false;

function announce(message, kind = "") { $("message").textContent = message; $("message").className = `notice ${kind}`; }
function localMessage(message, error = false) { $("local-message").textContent = message; $("local-message").className = `local-message${error ? " error" : ""}`; }

function updateSnapshotNotice() {
  const stale = snapshot.hubs.some((hub) => describeDataAge(hub.observedAt).tone === "stale");
  const scope = snapshot.scope.typeLimit === 0 ? "FULL LIVE BOOKS · Every item quoted at an active hub." :
    `LIVE SAMPLE · Up to ${snapshot.scope.typeLimit} tracked types per hub.`;
  const omitted = (snapshot.omittedHubs ?? []).map((hub) => `${hub.name}: ${hub.reason}${hub.status ? ` (${hub.status})` : ""}`).join(" · ");
  announce(snapshot.mode === "fixture" ? "SIMULATED DATA · Prices, type IDs and volumes are synthetic, with example item names. This tests the 60,000-row file and browser workflow. Connect EVE to collect live markets." :
    `${scope} History summaries come from the retained 21-day regional store. Collection took ${number.format(snapshot.statistics.durationMs / 1000)} s (${snapshot.statistics.requests} HTTP requests, ${snapshot.statistics.cacheHits} cache hits).${omitted ? ` Omitted hubs: ${omitted}.` : ""}${stale ? " At least one hub's market data is eight hours old or more." : ""}`,
    snapshot.mode === "fixture" || stale ? "fixture" : "live");
}

function refreshFreshness() {
  if (!snapshot) return;
  const cards = document.createDocumentFragment();
  for (const hub of snapshot.hubs) {
    const age = describeDataAge(hub.observedAt);
    const card = document.createElement("div"); card.className = `freshness-card ${age.tone}`; card.dataset.hub = hub.id;
    const heading = document.createElement("strong"); heading.textContent = hub.name;
    const ageLabel = document.createElement("span"); ageLabel.className = "data-age"; ageLabel.textContent = age.text;
    const time = document.createElement("time"); time.dateTime = hub.observedAt; time.textContent = dateTime.format(new Date(hub.observedAt));
    const label = document.createElement("span"); label.className = "caption"; label.textContent = snapshot.mode === "fixture" ? "Simulated market data as of" : "Market data as of";
    card.append(heading, ageLabel, label, time); cards.append(card);
  }
  $("freshness").replaceChildren(cards);
  const oldest = Math.min(...snapshot.hubs.map((hub) => Date.parse(hub.observedAt)));
  const age = describeDataAge(new Date(oldest).toISOString());
  $("age-summary").textContent = `Oldest hub · ${age.text}`;
  if (age.tone === "stale" && !$("age-panel").dataset.autoOpened) { $("age-panel").open = true; $("age-panel").dataset.autoOpened = "1"; }
  if (!$("message").classList.contains("error")) updateSnapshotNotice();
}

function renderProgress(progress) {
  if (!progress) return;
  $("collection-progress").hidden = false;
  $("collection-progress").classList.toggle("failed", progress.phase === "failed");
  $("progress-stage").textContent = progress.message;
  $("session-progress").textContent = progress.batchNumber ? `History pass · batch ${progress.batchNumber} · up to ${progress.batchLimit ?? 1000} requests per batch` : "";
  const orders = progress.phase === "orders";
  const complete = progress.hubsCompleted ?? 0, hubs = progress.hubTotal ?? snapshot?.hubs.length ?? 2;
  const savedQuotes = ["history", "verify"].includes(progress.jobKind);
  const parallelHubs = orders && Array.isArray(progress.hubs) ? progress.hubs : null;
  $("hub-progress-label").textContent = savedQuotes ? `Saved quotes · ${hubs} reference hubs` : orders && !parallelHubs ? `Hub ${progress.hubIndex} of ${hubs} · ${progress.hubName}` : `Order books · ${complete} of ${hubs} hubs complete`;
  $("hub-progress").max = hubs;
  $("hub-progress").value = savedQuotes ? hubs : parallelHubs ? parallelHubs.reduce((sum, hub) => sum + (hub.done ? 1 : hub.total ? hub.completed / hub.total : 0), 0) :
    Math.min(hubs, complete + (orders && complete < progress.hubIndex && progress.total ? progress.completed / progress.total : 0));
  $("hub-progress-detail").textContent = savedQuotes ? "No quote refresh requested" : parallelHubs ? `${parallelHubs.filter((hub) => !hub.done).length} hubs active` : `${complete} collected`;
  const total = progress.total, completed = progress.completed ?? 0;
  $("work-progress-label").textContent = orders ? total === null ? `Discovering page totals · ${integer.format(completed)} pages received…` :
    `Pages received · ${integer.format(completed)} of ${integer.format(total)}${!parallelHubs && progress.page > completed ? ` · fetching page ${progress.page}` : ""}` :
    progress.phase === "metadata" ? `Item details · ${integer.format(completed)} of ${integer.format(total)}` :
    progress.phase === "history" ? total === 0 ? "Regional history disabled" : `This batch · ${integer.format(completed)} of ${integer.format(total)} region/item pairs` :
    progress.phase === "complete" ? "Snapshot saved" : progress.phase === "failed" ? "Collection stopped · see run report for publication status" : progress.phase === "publishing" ? "Validating and saving snapshot…" : "Preparing collection…";
  const bar = $("work-progress"); bar.max = total || 1;
  if (total === null && progress.phase !== "failed") bar.removeAttribute("value");
  else bar.value = total === 0 ? 1 : completed;
  $("work-progress-detail").textContent = parallelHubs ? parallelHubs.map((hub) => `${hub.name}: ${hub.completed}/${hub.total ?? "?"}`).join(" · ") : orders ? `${integer.format(progress.ordersReceived ?? 0)} orders received` :
    total ? `${Math.round(completed / total * 100)}%` : "";
}

async function loadSnapshot() {
  $("reload").disabled = true;
  try {
    const response = await fetch("./data/market.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(`Snapshot download failed (${response.status}).`);
    const text = await response.text();
    const start = performance.now();
    const next = validateSnapshot(JSON.parse(text));
    const parseMs = performance.now() - start;
    snapshot = next; $("empty").textContent = "No matching items. Try another search or route.";
    populateMarkets();
    const total = next.hubs.reduce((sum, hub) => sum + hub.rows.length, 0);
    $("dataset").textContent = `${integer.format(total)} rows · ${next.mode === "fixture" ? "simulated" : next.scope.typeLimit === 0 ? "EVE full live books" : "EVE live sample"}`;
    $("size").textContent = `${(new Blob([text]).size / 1_000_000).toFixed(2)} MB · parsed + checked in ${parseMs.toFixed(0)} ms`;
    $("updated").textContent = dateTime.format(new Date(next.generatedAt));
    $("mode-label").textContent = next.mode === "fixture" ? "SIMULATED DATA" : next.scope.typeLimit ? "LIVE SAMPLE" : "LIVE MARKETS";
    $("browse-notice").textContent = next.mode === "fixture" ? "Simulated prices and demand. Use Setup & diagnostics to collect live markets." : (next.omittedHubs ?? []).map((hub) => `${hub.name}: ${hub.reason}${hub.status ? ` (${hub.status})` : ""}`).join(" · ");
    renderHistoryCoverage();
    updateSnapshotNotice(); refreshFreshness();
    recompute();
  } catch (error) {
    announce(`${error.message} ${snapshot ? "Keeping the previously loaded snapshot." : "The owner can connect the GitHub collector and run Resume / refresh markets from Setup & diagnostics."}`, "error");
    if (!snapshot) {
      $("browse-notice").textContent = "No published market snapshot yet. Open Setup & diagnostics to connect the collector and run Resume / refresh markets.";
      $("coverage").textContent = "Market collection has not published a dataset.";
      $("empty").textContent = "No market data published yet."; $("empty").hidden = false;
    }
  }
  finally { $("reload").disabled = false; }
}

function recompute() {
  if (!snapshot) return;
  const haul = Number($("haul").value), tax = Number($("tax").value);
  if (!Number.isFinite(haul) || haul < 0 || haul > 1_000_000 || !Number.isFinite(tax) || tax < 0 || tax > 100) return;
  const source = snapshot.hubs.find((hub) => hub.id === $("source").value);
  const destination = snapshot.hubs.find((hub) => hub.id === $("destination").value);
  $("route-label").textContent = `${source.name} → ${destination.name}`;
  $("strategy-label").textContent = $("sale").selectedOptions[0].textContent;
  $("source-column").dataset.title = `${source.name} ask`;
  $("destination-column").dataset.title = `${destination.name} ${$("sale").value === "instant" ? "bid" : "ask"}`;
  updateSortLabels();
  derived = sortOpportunities(compareHubs(snapshot, source.id, destination.id, { sale: $("sale").value, haul, tax, windowDays: Number($("window").value) }), sortKey, direction);
  derived = derived.map((row) => ({ ...row, recentAskOrders: row.competition?.recentAskOrders24h ?? null, recentAskUnits: row.competition?.recentAskUnits24h ?? null }));
  derived = sortOpportunities(derived, sortKey, direction);
  const knownHistory = derived.filter((row) => row.regionalWeekVolume !== null).length;
  const profitable = derived.filter((row) => row.profit !== null && row.profit > 0).length;
  $("coverage").textContent = source.id === destination.id ? "Choose different source and destination hubs." :
    `${integer.format(profitable)} positive unit-profit estimates · ${integer.format(knownHistory)} / ${integer.format(derived.length)} with complete ${$("window").value}-day regional demand`;
  applySearch();
}

function applySearch() {
  const search = $("search").value.trim().toLowerCase();
  filtered = search ? derived.filter((row) => row.itemName.toLowerCase().includes(search) || row.typeId.includes(search)) : derived;
  page = 0;
  renderRows();
}

function renderRows() {
  $("result-count").textContent = integer.format(filtered.length);
  const fragment = document.createDocumentFragment();
  for (const row of filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
    const tr = document.createElement("tr");
    for (const key of ["typeId", "itemName", "regionalWeekVolume", "acquisition", "landed", "destinationPrice", "margin", "grossWeekProfit", "estimatedWeekProfit", "fillerScore", "pricePerM3", "profit", "destinationUnits", "recentAskOrders", "recentAskUnits"]) {
      const td = document.createElement("td"), value = row[key];
      td.textContent = value == null ? "—" : ["typeId", "itemName"].includes(key) ? value : ["destinationUnits", "recentAskOrders", "recentAskUnits"].includes(key) ? integer.format(value) : number.format(value);
      if (value == null) td.className = "missing";
      else if (["profit", "estimatedWeekProfit", "grossWeekProfit", "margin"].includes(key)) td.className = value > 0 ? "positive" : value < 0 ? "negative" : "";
      if (key === "regionalWeekVolume" && row.history) td.title = `Coverage through ${row.history.asOfDate ?? "unknown"}; checked ${row.history.checkedAt ?? "never"}; last record ${row.history.lastRecordDate ?? "none"}`;
      tr.append(td);
    }
    fragment.append(tr);
  }
  $("rows").replaceChildren(fragment);
  $("empty").hidden = filtered.length !== 0;
  $("previous").disabled = page === 0;
  $("next").disabled = (page + 1) * PAGE_SIZE >= filtered.length;
  $("page-info").textContent = filtered.length ? `${integer.format(page * PAGE_SIZE + 1)}–${integer.format(Math.min((page + 1) * PAGE_SIZE, filtered.length))} of ${integer.format(filtered.length)} · 100 rows per page` : "0 items";
}

for (const id of ["source", "destination", "sale", "haul", "tax", "window"]) $(id).addEventListener("change", recompute);
$("search").addEventListener("input", applySearch);
$("reload").addEventListener("click", loadSnapshot);
$("swap").addEventListener("click", () => { const source = $("source").value; $("source").value = $("destination").value; $("destination").value = source; recompute(); });
$("previous").addEventListener("click", () => { page = Math.max(0, page - 1); renderRows(); });
$("next").addEventListener("click", () => { page++; renderRows(); });
for (const button of document.querySelectorAll("[data-sort]")) {
  const title = button.textContent.replace(/ [↑↓]$/, "");
  button.dataset.title = title;
  button.addEventListener("click", () => {
    direction = sortKey === button.dataset.sort && direction === "desc" ? "asc" : "desc";
    sortKey = button.dataset.sort;
    updateSortLabels();
    derived = sortOpportunities(derived, sortKey, direction); applySearch();
  });
}

async function status(fill = false) {
  if (HOSTED) return null;
  try {
    const response = await fetch("./local/status", { cache: "no-store" });
    if (!response.ok) return null;
    const result = await response.json();
    if (typeof result.csrf !== "string") return null;
    localStatus = result;
    $("local-panel").hidden = false;
    $("character").textContent = result.character ?? "Not connected";
    $("connection-summary").textContent = result.busy ? "Collection in progress…" : result.connected ? `Connected · ${result.character}` : "Not connected · fixture mode is ready";
    $("callback").textContent = result.callback;
    $("disconnect").hidden = !result.connected;
    $("connect").textContent = result.connected ? "Reconnect EVE" : "Connect EVE";
    for (const id of ["connect", "disconnect", "collect", "fixture", "history", "verify", "quotes"]) $(id).disabled = result.busy;
    $("settings").querySelector("button").disabled = result.busy;
    renderProgress(result.progress);
    const resumable = !result.busy && ["paused", "running", "interrupted", "cancelled", "rate-limit", "source-errors"].includes(result.historySession?.status);
    $("history").textContent = resumable ? "Resume history" : "Update / verify history";
    $("history").dataset.resume = resumable ? "true" : "false";
    $("pause-history").hidden = !result.busy || !["history", "collect"].includes(result.progress?.jobKind);
    $("pause-history").disabled = Boolean(result.pauseRequested);
    $("pause-history").textContent = result.pauseRequested ? "Pausing after this batch…" : "Pause after this batch";
    const batchKey = result.progress?.sessionId && `${result.progress.sessionId}:${result.progress.batchNumber}`;
    if (batchKey && lastHistoryBatch !== batchKey) { lastHistoryBatch = batchKey; void loadMetrics(); void loadHistoryState(); }
    if (result.progress?.runId && result.progress.phase === "history" && lastQuotesRun !== result.progress.runId) {
      lastQuotesRun = result.progress.runId; void loadSnapshot();
    }
    if (fill) {
      for (const key of ["clientId", "tortugaId", "cjId", "contact", "typeLimit", "historyBatchSeconds"]) $("settings").elements.namedItem(key).value = result.config[key];
      $("settings").elements.namedItem("tortugaEnabled").checked = result.config.tortugaEnabled === true;
      $("settings").elements.namedItem("clientSecret").placeholder = result.config.hasClientSecret ? "Saved legacy value · local PKCE does not use it" : "Not required for local PKCE login";
      if (!result.config.hasClientSecret) $("local-panel").open = true;
    }
    return result;
  } catch { return null; }
}

async function post(path, body = {}) {
  const current = localStatus ?? await status();
  if (!current) throw new Error("The local collector is unavailable. Start npm run backend to use setup and collection.");
  const response = await fetch(`./local/${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Local-CSRF": current.csrf }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Local operation failed.");
  return result;
}

$("settings").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const values = Object.fromEntries(new FormData(event.currentTarget));
    values.tortugaEnabled = event.currentTarget.elements.namedItem("tortugaEnabled").checked;
    await post("config", values);
    $("settings").elements.namedItem("clientSecret").value = "";
    await status(true);
    localMessage("Settings saved locally. Connect EVE, then collect live markets when both structure IDs are ready.");
  } catch (error) { localMessage(error.message, true); }
});
$("connect").addEventListener("click", async () => {
  try { const result = await post("connect"); window.location.assign(result.url); }
  catch (error) { localMessage(error.message, true); }
});
$("disconnect").addEventListener("click", async () => {
  try { await post("disconnect"); await status(); localMessage("Local grant removed. Existing public snapshots remain available; revoke the application in EVE to revoke its upstream grant."); }
  catch (error) { localMessage(error.message, true); }
});

async function runCollection(mode) {
  if (polling) return;
  try {
    polling = true;
    await post(mode, { resume: mode === "history" && $("history").dataset.resume === "true" });
    $("local-panel").open = true;
    renderProgress({ phase: "starting", message: "Starting collection…", hubsCompleted: 0, hubTotal: snapshot?.hubs.length ?? 2, completed: 0, total: null });
    localMessage(mode === "fixture" ? "Generating the 60,000-row simulated snapshot…" : "Running collection. Quotes are saved first; history runs in a resumable batch. See progress below.");
    await waitForCollection();
  } catch (error) { localMessage(error.message, true); }
  finally { polling = false; }
}

async function waitForCollection() {
  let result;
  do { await new Promise((resolve) => setTimeout(resolve, 2000)); result = await status(); if (!result) throw new Error("Local server stopped. Restart it and reload the snapshot."); } while (result.busy);
  if (result.lastError) throw new Error(result.lastError);
  await loadSnapshot();
  await loadMetrics();
  await loadHistoryState();
  localMessage(result.progress?.message ?? "Run completed.");
}
$("collect").addEventListener("click", () => runCollection("collect"));
$("fixture").addEventListener("click", () => runCollection("fixture"));
$("quotes").addEventListener("click", () => runCollection("quotes"));
$("history").addEventListener("click", () => runCollection("history"));
$("verify").addEventListener("click", () => runCollection("verify"));
$("pause-history").addEventListener("click", async () => {
  try { await post("pause-history"); await status(); localMessage("Pause requested. The current batch will finish and publish; Resume history will continue the saved pass."); }
  catch (error) { localMessage(error.message, true); }
});

navigate();
await loadSnapshot();
await loadMetrics();
await loadHistoryState();
const current = await status(true);
if (current?.lastError) { $("local-panel").open = true; localMessage(current.lastError, true); }
if (current?.busy) {
  $("local-panel").open = true; localMessage("A local operation is still running.");
  if (current.progress) {
    polling = true;
    void waitForCollection().catch((error) => localMessage(error.message, true)).finally(() => { polling = false; });
  }
}
setInterval(refreshFreshness, 60_000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshFreshness(); });
const feedback = new URLSearchParams(location.search);
if (feedback.get("connected") === "1" && current?.connected && !current.lastError) {
  location.hash = "setup"; $("local-panel").open = true; localMessage("Character connected. Confirm both hub IDs, then collect live markets.");
}
if (feedback.has("auth") || feedback.has("connected")) {
  // OAuth result flags are one-time feedback, not proof of a current connection.
  feedback.delete("auth"); feedback.delete("connected");
  history.replaceState(null, "", `${location.pathname}${feedback.size ? `?${feedback}` : ""}${location.hash}`);
}

function updateSortLabels() {
  for (const other of document.querySelectorAll("[data-sort]")) {
    other.textContent = `${other.dataset.title}${other.dataset.sort === sortKey ? direction === "asc" ? " ↑" : " ↓" : ""}`;
    other.closest("th").setAttribute("aria-sort", other.dataset.sort === sortKey ? direction === "asc" ? "ascending" : "descending" : "none");
  }
}

function renderHistoryCoverage() {
  const fragment = document.createDocumentFragment();
  for (const hub of snapshot.hubs) {
    const known = hub.rows.filter((row) => row.history?.checkedAt), summary = document.createElement("div"); summary.className = "history-region";
    const heading = document.createElement("strong"); heading.textContent = `${hub.name} · region ${hub.regionId}`;
    const range = (key) => { const values = known.map((row) => row.history[key]).filter(Boolean).sort(); return values.length ? values[0] === values.at(-1) ? values[0] : `${values[0]} … ${values.at(-1)}` : "not yet available"; };
    summary.append(heading, document.createTextNode(`${known.length} / ${hub.rows.length} checked · ${hub.rows.filter((row) => row.regionalWeekVolume !== null).length} complete 7-day summaries`));
    for (const [key, label] of [["checkedAt", "Last checks"], ["sourceUpdatedAt", "Source updates"], ["asOfDate", "Coverage through"], ["lastRecordDate", "Last actual records"]]) {
      const line = document.createElement("div"); line.textContent = `${label}: ${range(key)}`; summary.append(line);
    }
    fragment.append(summary);
  }
  $("history-coverage").replaceChildren(fragment);
}

async function loadMetrics() {
  if (HOSTED) return;
  try {
    const response = await fetch("./local/metrics", { cache: "no-store" });
    if (!response.ok) { $("metrics-download").hidden = true; return; }
    const { runs } = await response.json();
    if (!Array.isArray(runs)) return;
    $("metrics-empty").hidden = runs.length > 0;
    const fragment = document.createDocumentFragment();
    for (const run of runs) {
      const tr = document.createElement("tr"), first = document.createElement("td"), button = document.createElement("button");
      button.className = "metric-link"; button.textContent = `${new Date(run.startedAt).toLocaleString()} · ${run.kind}${run.batchNumber ? ` · batch ${run.batchNumber}` : ""}`;
      button.addEventListener("click", () => { $("metrics-detail").hidden = false; $("metrics-detail").textContent = JSON.stringify(run, null, 2); });
      first.append(button); tr.append(first);
      const h = run.history;
      const values = [run.status, `${number.format((run.durationMs ?? 0) / 1000)} s / ${number.format((run.cpuUserMs ?? 0) + (run.cpuSystemMs ?? 0))} ms`, `${number.format((run.maxRssKiB ?? 0) / 1024)} MiB`,
        `${(run.quoteRequests?.requests ?? 0) + (h?.requests ?? 0)} / ${(run.quoteRequests?.cacheHits ?? 0) + (h?.cacheHits ?? 0)}${h ? ` (+${h.freshPairs ?? 0} fresh pairs)` : ""}`,
        h ? `${h.refreshedPairs ?? 0} / ${h.remainingEligiblePairs ?? h.pendingPairs ?? 0} / ${h.deferredPairsNow ?? h.deferredPairs ?? 0}` : run.verification ? `${run.verification.series} local series` : "—",
        h ? `${h.insertedDays ?? 0} / ${h.correctedDays ?? 0} / ${h.unchangedDays ?? 0} / ${h.prunedDays ?? 0}` : "—"];
      for (const value of values) { const td = document.createElement("td"); td.textContent = value; tr.append(td); }
      fragment.append(tr);
    }
    $("metrics-rows").replaceChildren(fragment);
  } catch { /* Static export has no local diagnostics endpoint. */ }
}

function navigate() {
  const setup = location.hash === "#setup";
  $("browse-page").hidden = setup; $("setup-page").hidden = !setup;
  $("browse-link").setAttribute("aria-current", setup ? "false" : "page");
  $("setup-link").setAttribute("aria-current", setup ? "page" : "false");
  if (setup) { void loadMetrics(); void loadHistoryState(); }
}
window.addEventListener("hashchange", navigate);
navigate();

function elapsed(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60000), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  return days ? `${days}d ${hours % 24}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}
function refreshDeferredAges() {
  for (const cell of document.querySelectorAll("[data-deferred-since]")) cell.textContent = elapsed(Date.now() - Date.parse(cell.dataset.deferredSince));
  for (const cell of document.querySelectorAll("[data-retry-at]")) cell.textContent = Date.parse(cell.dataset.retryAt) <= Date.now() ? "Eligible on next pass" : elapsed(Date.parse(cell.dataset.retryAt) - Date.now());
}
async function loadHistoryState() {
  if (HOSTED) return;
  try {
    const response = await fetch("./local/history-state", { cache: "no-store" });
    if (!response.ok) { $("deferred-panel").hidden = true; return; }
    const result = await response.json(); if (!Array.isArray(result.deferred)) return;
    $("deferred-panel").hidden = false;
    $("history-state-summary").textContent = result.targetPairs ? `${integer.format(result.collectedPairs)} / ${integer.format(result.targetPairs)} pairs ever collected · ${integer.format(result.freshPairs)} currently fresh · ${integer.format(result.eligiblePairs)} eligible · ${integer.format(result.deferredPairs)} waiting for retry. Backfill coverage and current freshness are separate.` : "Collect live markets to populate history.";
    $("deferred-count").textContent = integer.format(result.deferred.length);
    $("deferred-empty").hidden = result.deferred.length > 0;
    const fragment = document.createDocumentFragment();
    for (const item of result.deferred.slice(0, 200)) {
      const tr = document.createElement("tr");
      const values = [`${item.itemName} · ${item.typeId}`, item.regionId, item.reason, dateTime.format(new Date(item.deferredSince)), "", dateTime.format(new Date(item.lastAttemptAt)), dateTime.format(new Date(item.retryAt)), "", item.failureCount];
      values.forEach((value, index) => { const td = document.createElement("td"); td.textContent = value;
        if (index === 4) td.dataset.deferredSince = item.deferredSince;
        if (index === 7) td.dataset.retryAt = item.retryAt;
        tr.append(td);
      }); fragment.append(tr);
    }
    $("deferred-rows").replaceChildren(fragment); refreshDeferredAges();
    if (result.deferred.length > 200) $("history-state-summary").textContent += " Showing the first 200 deferred pairs; download includes all.";
  } catch { /* A running checkpoint may briefly delay local diagnostics. */ }
}
setInterval(refreshDeferredAges, 60000);

function populateMarkets() {
  const source = $("source").value, destination = $("destination").value;
  for (const id of ["source", "destination"]) {
    const options = snapshot.hubs.map((hub) => { const option = document.createElement("option"); option.value = hub.id; option.textContent = hub.name; return option; });
    $(id).replaceChildren(...options);
  }
  const exists = (id) => snapshot.hubs.some((hub) => hub.id === id);
  $("source").value = exists(source) ? source : exists("jita") ? "jita" : snapshot.hubs[0].id;
  $("destination").value = exists(destination) ? destination : exists("cj6mt") ? "cj6mt" : snapshot.hubs.find((hub) => hub.id !== $("source").value)?.id ?? snapshot.hubs[0].id;
}
