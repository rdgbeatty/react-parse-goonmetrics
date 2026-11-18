import { createRequire } from "node:module";
import { createPrivateKey, sign, webcrypto } from "node:crypto";
import { GitHubApi, sodiumSealer } from "./github-client.mjs";
// CJS sodium supports Node 18's crypto provider as well as the hosted Node LTS.
globalThis.crypto ??= webcrypto;
const sodium = createRequire(import.meta.url)("libsodium-wrappers");
export const nodeSealer = sodiumSealer(sodium);
export function maskSecret(value, output = process.stdout) {
  if (process.env.GITHUB_ACTIONS === "true" && typeof value === "string" && value) output.write(`::add-mask::${value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}\n`);
}
export async function secretWriter(config, env = process.env, fetchImpl = fetch) {
  let token = env.MARKET_WRITER_TOKEN;
  if (!token) {
    if (!/^\d+$/.test(env.MARKET_APP_ID ?? "") || !/^\d+$/.test(env.MARKET_APP_INSTALLATION_ID ?? "") || !env.MARKET_APP_PRIVATE_KEY) {
      throw new Error("Configure MARKET_WRITER_TOKEN, or the three MARKET_APP credentials, in collector environment Secrets.");
    }
    const now = Math.floor(Date.now() / 1000);
    let jwt;
    try {
      const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
      const claims = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.MARKET_APP_ID })).toString("base64url");
      const data = `${header}.${claims}`;
      jwt = `${data}.${sign("RSA-SHA256", Buffer.from(data), createPrivateKey(env.MARKET_APP_PRIVATE_KEY)).toString("base64url")}`;
    } catch { throw new Error("Cannot sign the configured GitHub App credential."); }
    maskSecret(jwt);
    const api = new GitHubApi({ repository: config.repository, token: jwt, fetchImpl });
    const result = await api.request(`/app/installations/${env.MARKET_APP_INSTALLATION_ID}/access_tokens`, { method: "POST",
      body: { repositories: [config.repository.split("/")[1]], permissions: { environments: "write" } } });
    token = result.token;
    if (typeof token !== "string" || !token) throw new Error("GitHub App did not return an installation token.");
  }
  maskSecret(token);
  return new GitHubApi({ repository: config.repository, environment: config.environment, token, seal: nodeSealer, fetchImpl });
}
