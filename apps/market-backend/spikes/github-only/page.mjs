import { BrowserEveSso, probeBrowserAccess } from "./eve-browser.mjs";
const $ = (id) => document.getElementById(id);
const callbackUrl = new URL(location.href);
// Remove the one-use code before requests/navigation; never render its value.
if (callbackUrl.searchParams.has("code") || callbackUrl.searchParams.has("error")) history.replaceState(null, "", location.pathname);
const redirectUri = `${location.origin}/auth/eve/callback`;
$("callback").textContent = redirectUri;
let grant = null;
let sso;
try { sso = new BrowserEveSso(); }
catch { $("login-status").textContent = "Session storage is unavailable. Allow session storage in this tab before testing EVE sign-in."; $("connect").disabled = true; }
$("probe").onclick = async () => {
  $("probe").disabled = true; $("results").replaceChildren(); $("probe-status").textContent = "Checking browser access…";
  try {
    const results = await probeBrowserAccess({ id: $("client-id").value.trim() || undefined });
    for (const result of results) {
      const row = document.createElement("tr");
      for (const value of [result.name, result.readable ? "Yes" : "Blocked / network error", result.status ?? "—", `${result.elapsedMs} ms`]) {
        const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
      }
      $("results").append(row);
    }
    $("probe-status").textContent = results.every((r) => r.readable)
      ? "All responses readable. Successful EVE login and GitHub Secret writes require separate tests."
      : "Some responses were unreadable. Inspect Chrome’s Network panel for CORS or connectivity failures.";
    document.documentElement.dataset.probeComplete = "true";
  } catch (error) { $("probe-status").textContent = error.message; }
  finally { $("probe").disabled = false; }
};
$("connect").onclick = async () => {
  grant = null; $("forget").disabled = true; $("connect").disabled = true;
  try { location.assign(await sso.begin($("client-id").value.trim(), redirectUri)); }
  catch (error) { $("login-status").textContent = error.message; $("connect").disabled = false; }
};
$("forget").onclick = () => { grant = null; $("forget").disabled = true; $("login-status").textContent = "Test grant forgotten. EVE account revocation is a separate operation."; };
if (sso && (callbackUrl.searchParams.has("code") || callbackUrl.searchParams.has("error"))) {
  $("connect").disabled = true; $("login-status").textContent = "Exchanging code and checking the signed character token in this browser…";
  try {
    grant = await sso.complete(callbackUrl.href);
    $("login-status").textContent = `Verified ${grant.character.name} (${grant.character.id}).\nBoth required scopes verified. Refresh grant received and held in memory.\nNo tokens saved locally or sent to GitHub.`;
    $("forget").disabled = false;
  } catch (error) { $("login-status").textContent = error.message; }
  finally { $("connect").disabled = false; }
}
if (callbackUrl.searchParams.get("probe") === "1") $("probe").click();
