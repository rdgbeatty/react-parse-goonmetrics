import { DEFAULT_STATE } from "./lib/paths.mjs";
import { withLock } from "./lib/storage.mjs";
import { removeLegacyOrderCaches } from "./lib/maintenance.mjs";

try { console.log(JSON.stringify(await withLock(DEFAULT_STATE, () => removeLegacyOrderCaches(DEFAULT_STATE)), null, 2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
