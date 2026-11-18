import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
// Existing credentials and snapshots stay where they are; fresh installs use the scaffold name.
export const DEFAULT_STATE = join(ROOT, existsSync(join(ROOT, ".market-poc")) ? ".market-poc" : ".market-backend");
