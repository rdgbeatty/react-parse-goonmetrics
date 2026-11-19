// Shared browser/runner REST client. Never include upstream response bodies in errors.
export class GitHubApi {
  constructor({ repository, token, environment = "market-collector", fetchImpl = globalThis.fetch.bind(globalThis), seal }) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Expected GitHub owner/repository.");
    if (!token || /\s/.test(token)) throw new Error("Supply a GitHub token with the documented permissions.");
    if (!/^[A-Za-z0-9_-]+$/.test(environment)) throw new Error("Invalid collector environment.");
    this.repository = repository; this.token = token; this.environment = environment; this.fetch = fetchImpl; this.seal = seal;
    this.base = `/repos/${repository}`;
  }
  async request(path, { method = "GET", body, allow404 = false, raw = false } = {}) {
    if (!path.startsWith("/repos/") && path !== "/user" && !/^\/app\/installations\/\d+\/access_tokens$/.test(path)) throw new Error("Unexpected GitHub API path.");
    let response;
    try { response = await this.fetch(`https://api.github.com${path}`, { method, credentials: "omit", redirect: "error",
      referrerPolicy: "no-referrer", signal: AbortSignal.timeout(30_000),
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.token}`, "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
    catch { throw new Error("GitHub request could not complete. Check connectivity and retry; never paste credentials into a report."); }
    if (allow404 && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`GitHub ${method} request failed (${response.status}). Check token permissions, expiration and repository/environment setup.`); }
    if (raw) return response;
    if (response.status === 204) return null;
    try { const text = await response.text(); return text ? JSON.parse(text) : null; } catch { throw new Error("GitHub returned an unreadable response."); }
  }
  async verifyOwner(branch) {
    const user = await this.request("/user"), repo = await this.request(this.base);
    if (user.login?.toLowerCase() !== this.repository.split("/")[0].toLowerCase() || !repo.permissions?.push || repo.default_branch !== branch) {
      throw new Error("Owner setup requires the repository owner's GitHub account and its configured default branch.");
    }
    return user.login;
  }
  async setSecret(name, value) {
    if (!/^[A-Z][A-Z0-9_]+$/.test(name) || name.startsWith("GITHUB_")) throw new Error("Invalid Secret name.");
    if (typeof value !== "string" || new TextEncoder().encode(value).length > 45_000 || !this.seal) throw new Error("Invalid Secret value or encryption provider.");
    const path = `${this.base}/environments/${this.environment}/secrets`;
    const key = await this.request(`${path}/public-key`);
    const encrypted = await this.seal(value, key.key);
    await this.request(`${path}/${name}`, { method: "PUT", body: { encrypted_value: encrypted, key_id: key.key_id } });
  }
  deleteSecret(name) {
    if (!/^[A-Z][A-Z0-9_]+$/.test(name)) throw new Error("Invalid Secret name.");
    return this.request(`${this.base}/environments/${this.environment}/secrets/${name}`, { method: "DELETE", allow404: true });
  }
  dispatch(operation, branch, nonce = "") {
    if (!["adopt", "quotes", "history", "resume", "catalog"].includes(operation) || !/^[A-Za-z0-9._/-]+$/.test(branch) ||
      (nonce && !/^[a-f0-9]{64}$/.test(nonce))) throw new Error("Invalid collector operation.");
    return this.request(`${this.base}/actions/workflows/market-collect.yml/dispatches`, { method: "POST", body: { ref: branch, inputs: { operation, nonce } } });
  }
}

export function sodiumSealer(sodium) {
  return async (value, publicKey) => {
    await sodium.ready;
    const key = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
    if (key.length !== 32) throw new Error("GitHub returned an invalid encryption key.");
    return sodium.to_base64(sodium.crypto_box_seal(sodium.from_string(value), key), sodium.base64_variants.ORIGINAL);
  };
}
