// Active locations belong to collector configuration; the viewer uses the snapshot.
// A retained Tortuga ID alone never re-enables the retired market.
export function configuredHubs(config) {
  const hubs = [
    { id: "jita", name: "Jita", kind: "public", locationId: "60003760", regionId: "10000002", enabled: true, required: true },
    { id: "cj6mt", name: "C-J6MT", kind: "structure", locationId: config.cjId, expectedSystem: "C-J6MT", enabled: true, required: true },
    { id: "tortuga", name: "Tortuga · Siseide", kind: "structure", locationId: config.tortugaId ?? "", expectedSystem: "Siseide", enabled: config.tortugaEnabled === true, required: false },
  ];
  if (config.tortugaEnabled !== undefined && typeof config.tortugaEnabled !== "boolean") throw new Error("Tortuga enabled must be true or false.");
  if (config.additionalHubs !== undefined && (!Array.isArray(config.additionalHubs) || config.additionalHubs.length > 13)) throw new Error("Additional hubs must be an array of up to 13 structures.");
  for (const hub of config.additionalHubs ?? []) {
    if (!hub || Object.keys(hub).some((key) => !["id", "name", "structureId", "expectedSystem", "enabled", "required"].includes(key)) ||
      hub.enabled !== undefined && typeof hub.enabled !== "boolean" || hub.required !== undefined && typeof hub.required !== "boolean") throw new Error("Invalid additional hub configuration.");
    hubs.push({ id: hub.id, name: hub.name, kind: "structure", locationId: hub.structureId,
      expectedSystem: hub.expectedSystem, enabled: hub.enabled !== false, required: hub.required === true });
  }
  const seenIds = new Set(), seenLocations = new Set();
  for (const hub of hubs) {
    if (typeof hub.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(hub.id) || seenIds.has(hub.id) ||
      typeof hub.name !== "string" || !hub.name.trim() || hub.name.length > 120 || /[\r\n]/.test(hub.name) ||
      hub.expectedSystem !== undefined && (typeof hub.expectedSystem !== "string" || !hub.expectedSystem.trim())) throw new Error("Invalid or duplicate hub identity.");
    seenIds.add(hub.id);
    if (!hub.enabled) continue;
    if (typeof hub.locationId !== "string" || !/^\d{1,16}$/.test(hub.locationId) || !Number.isSafeInteger(Number(hub.locationId))) throw new Error(`Enter a numeric structure ID for ${hub.name}.`);
    if (seenLocations.has(hub.locationId)) throw new Error("Enabled hubs must have different location IDs.");
    seenLocations.add(hub.locationId);
  }
  return hubs;
}
