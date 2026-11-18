import { configuredHubs } from "./hubs.mjs";
export function validateReleaseConfig(value) {
  const keys = new Set(["schemaVersion", "repository", "branch", "environment", "clientId", "collectorCharacterId", "cjId", "additionalHubs", "contact", "typeLimit", "historyBatchSeconds", "legacyApi"]);
  if (!value || Object.keys(value).some((key) => !keys.has(key)) || value.schemaVersion !== 1 ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository) || !/^[A-Za-z0-9._/-]+$/.test(value.branch) ||
    !/^[A-Za-z0-9_-]+$/.test(value.environment) || !/^[A-Za-z0-9_-]{1,128}$/.test(value.clientId) ||
    !/^\d+$/.test(value.collectorCharacterId) || !/^\d+$/.test(value.cjId) || !Array.isArray(value.additionalHubs) ||
    typeof value.contact !== "string" || !value.contact.trim() || value.typeLimit !== 0 || value.historyBatchSeconds !== 300) throw new Error("Invalid public release config. Use the documented nonsecret fields in config/market.json.");
  for (const hub of value.additionalHubs) if (!hub || Object.keys(hub).some((k) => !["id", "name", "structureId", "expectedSystem", "enabled", "required"].includes(k)) || !/^[a-z][a-z0-9_-]{0,31}$/.test(hub.id) || typeof hub.name !== "string" || hub.name.length > 100 || !/^\d+$/.test(hub.structureId) || (hub.expectedSystem !== undefined && typeof hub.expectedSystem !== "string") || (hub.enabled !== undefined && typeof hub.enabled !== "boolean") || (hub.required !== undefined && typeof hub.required !== "boolean")) throw new Error("Unexpected additional hub config field.");
  const api = new URL(value.legacyApi);
  if (api.protocol !== "https:" || api.username || api.password || api.search || api.hash || api.pathname !== "/") throw new Error("Legacy API must be an HTTPS origin.");
  configuredHubs(value);
  return { ...value, legacyApi: api.origin };
}
