import "../public/styles.css";
import sodium from "libsodium-wrappers";
import { BrowserEveSso } from "../spikes/github-only/eve-browser.mjs";
import { GitHubApi, sodiumSealer } from "../lib/github-client.mjs";
import { validateReleaseConfig } from "../lib/release-config.mjs";
const $ = (id) => document.getElementById(id);
const callback = new URL(location.href);
if (callback.search) history.replaceState(null, "", location.pathname);
let config, grant = null, pendingNonce = null;
const sso = new BrowserEveSso();
const message = (text, error = false) => { $("status").textContent = text; $("status").className = `notice${error ? " error" : ""}`; };
const redirectUri = `${location.origin}${location.pathname}`;
function busy(value) { for (const b of document.querySelectorAll("button")) b.disabled = value; if (!value) { $("save").disabled = !grant; $("forget").disabled = !grant && !$("token").value; } }
async function owner() {
  const api = new GitHubApi({ ...config, token: $("token").value.trim(), seal: sodiumSealer(sodium) });
  await api.verifyOwner(config.branch); return api;
}
async function action(fn) { busy(true); try { await fn(); } catch (e) { message(e.message, true); } finally { busy(false); } }
try {
  const response = await fetch("./hosted-config.json", { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
  if (!response.ok) throw new Error("Public collector configuration is unavailable.");
  config = validateReleaseConfig(await response.json());
  $("callback").textContent = redirectUri; $("character-id").textContent = config.collectorCharacterId; $("repository").textContent = config.repository;
  $("runs").href = `https://github.com/${config.repository}/actions/workflows/market-collect.yml`;
  $("connect").disabled = false;
  message("Ready. Connect EVE, then authorize encrypted GitHub storage.");
  if (callback.searchParams.has("code") || callback.searchParams.has("error")) {
    message("Exchanging the EVE code and verifying the character…");
    grant = await sso.complete(callback.href);
    if (grant.character.id !== config.collectorCharacterId) { grant = null; throw new Error("Select the configured collector character. The working grant was not changed."); }
    $("character").textContent = `Verified ${grant.character.name} (${grant.character.id}). Grant held in this tab’s memory.`;
    $("save").disabled = false; $("forget").disabled = false;
    message("EVE connected in this browser. Supply GitHub owner authorization to save it.");
  }
} catch (e) { message(e.message, true); }
$("connect").onclick = () => action(async () => { if (!config) throw new Error("Load a valid public configuration first."); grant = null; location.assign(await sso.begin(config.clientId, redirectUri)); });
$("forget").onclick = () => { grant = null; $("token").value = ""; busy(false); $("character").textContent = "Browser credentials forgotten. This does not revoke or disconnect the hosted collector."; };
$("token").oninput = () => { $("forget").disabled = !grant && !$("token").value; };
$("save").onclick = () => action(async () => {
  if (!grant || !config) throw new Error("Connect the approved EVE character first.");
  const api = await owner();
  pendingNonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  await api.setSecret("EVE_PENDING_GRANT", JSON.stringify({ schemaVersion: 1, repository: config.repository, clientId: config.clientId,
    nonce: pendingNonce, createdAt: new Date().toISOString(), grant }));
  grant = null; $("character").textContent = "Encrypted grant staged in GitHub. Waiting for the adoption workflow.";
  $("retry").hidden = false;
  message("Grant staged. Starting its validation workflow…");
  await api.dispatch("adopt", config.branch, pendingNonce);
  $("token").value = "";
  message("Setup pending. Check the collector run: it must succeed before this grant is active. Then use Resume / refresh markets.");
});
$("retry").onclick = () => action(async () => {
  if (!pendingNonce) throw new Error("Start a new EVE connection after reloading this page.");
  const api = await owner(); await api.dispatch("adopt", config.branch, pendingNonce); $("token").value = "";
  message("Pending setup dispatched again. Check its run result before collecting.");
});
for (const button of document.querySelectorAll("[data-operation]")) button.onclick = () => action(async () => {
  const api = await owner(); await api.dispatch(button.dataset.operation, config.branch); $("token").value = "";
  message("Collection queued. Open collector runs for progress and results; reload the viewer after publication.");
});
window.addEventListener("pagehide", () => { grant = null; $("token").value = ""; });
