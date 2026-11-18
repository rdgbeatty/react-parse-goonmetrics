// Static catalog contract. Type IDs are dictionary keys, so names never act as identities.
export const CATALOG_VERSION = 1;

export function validateCatalog(catalog) {
  if (!catalog || catalog.schemaVersion !== CATALOG_VERSION || !catalog.types || Array.isArray(catalog.types) ||
    Object.keys(catalog).some((key) => !["schemaVersion", "types"].includes(key))) throw new Error("Invalid catalog envelope.");
  const allowed = ["name", "groupId", "marketGroupId", "published", "volumeM3", "packagedVolumeM3"];
  const entries = Object.entries(catalog.types);
  if (!entries.length) throw new Error("The catalog contains no types.");
  for (const [id, type] of entries) {
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)) || !type || Object.keys(type).some((key) => !allowed.includes(key)) ||
      typeof type.name !== "string" || !type.name.trim() || !Number.isSafeInteger(type.groupId) || type.groupId < 0 || type.published && type.groupId === 0 ||
      !(type.marketGroupId === null || Number.isSafeInteger(type.marketGroupId) && type.marketGroupId > 0) || typeof type.published !== "boolean") {
      throw new Error(`Invalid catalog type ${id}: ${JSON.stringify(type)}.`);
    }
    for (const key of ["volumeM3", "packagedVolumeM3"]) {
      if (!(type[key] === null || typeof type[key] === "number" && Number.isFinite(type[key]) && type[key] >= 0)) throw new Error(`Invalid ${key} for catalog type ${id}.`);
    }
  }
  return catalog;
}
