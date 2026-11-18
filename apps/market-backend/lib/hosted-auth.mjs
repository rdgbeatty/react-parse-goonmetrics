import { join } from "node:path";
import { writeJson } from "./storage.mjs";
import { maskSecret } from "./github-node.mjs";

export function parseGrant(text, expectedCharacter) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("Collector Secret is absent or invalid. Connect EVE from owner setup."); }
  if (!value || value.authentication !== "pkce" || typeof value.refreshToken !== "string" || !value.refreshToken || value.refreshToken.length > 16_000 ||
      String(value.character?.id) !== String(expectedCharacter)) throw new Error("Collector grant does not match the approved PKCE character.");
  maskSecret(value.refreshToken);
  return { authentication: "pkce", refreshToken: value.refreshToken, character: { id: String(value.character.id), name: String(value.character.name ?? value.character.id) }, ...(/^[a-f0-9]{64}$/.test(value.setupNonce ?? "") ? { setupNonce: value.setupNonce } : {}) };
}

export async function adoptGrant({ config, pendingText, nonce, currentText, writer, sso, now = Date.now() }) {
  let pending;
  try { pending = JSON.parse(pendingText); } catch { throw new Error("No valid pending grant. Connect EVE and save a new pending grant."); }
  if (!/^[a-f0-9]{64}$/.test(nonce ?? "") || pending?.schemaVersion !== 1 || pending?.nonce !== nonce || pending.repository !== config.repository || pending.clientId !== config.clientId ||
      !Number.isFinite(Date.parse(pending.createdAt)) || now - Date.parse(pending.createdAt) < -60_000 || now - Date.parse(pending.createdAt) > 24 * 3600_000) {
    throw new Error("Pending setup is expired, superseded, or does not match this repository/application.");
  }
  if (currentText) {
    try { const current = parseGrant(currentText, config.collectorCharacterId); if (current.setupNonce === nonce) return current; }
    catch { /* A new verified setup can repair an unusable canonical value. */ }
  }
  const grant = parseGrant(JSON.stringify(pending.grant), config.collectorCharacterId);
  // Bootstrap callbacks stay in memory until signed character verification passes.
  let replacement;
  const result = await sso.refresh(config, grant, async (value) => { maskSecret(value.refreshToken); replacement = value; });
  if (String(result.character.id) !== String(config.collectorCharacterId) || !replacement) throw new Error("EVE validated a different collector character.");
  const canonical = { ...replacement, character: result.character, setupNonce: nonce };
  await writer.setSecret("EVE_GRANT", JSON.stringify(canonical));
  // Never delete pending here: a newer browser login may have replaced it while
  // this job was validating. It is private, ignored by normal runs, and overwritten
  // on the next setup. setupNonce makes adoption retries idempotent.
  return canonical;
}

// Normal authenticated refreshes preserve replacements before validation/ESI can fail.
export function durableSso(sso, writer, expectedCharacter) {
  return { refresh: async (config, current, persist) => {
    if (String(current?.character?.id) !== String(expectedCharacter)) throw new Error("Saved grant character is not approved.");
    return sso.refresh(config, current, async (grant) => {
      maskSecret(grant.refreshToken);
      const durable = { ...grant, ...(current.setupNonce ? { setupNonce: current.setupNonce } : {}) };
      await writer.setSecret("EVE_GRANT", JSON.stringify(durable));
      await persist(durable);
    });
  } };
}
export async function installGrant(directory, grant) { await writeJson(join(directory, "private", "grant.json"), grant); }
