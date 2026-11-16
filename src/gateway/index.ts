// The hosted gateway (docs/deployment-railway.md): `bun src/gateway/index.ts`
// on Railway, or `bun run dev:hosted` locally. It signs users in, keeps their
// secrets, and runs one app server per user behind itself.
//
//   bun src/gateway/index.ts genkey   prints a fresh SPECDRIVEN_MASTER_KEY
//   bun src/gateway/index.ts probe    tries the workers' confinement on this
//                                     machine and says what holds
//
// Started as root with setpriv installed, as in the hosted image, it is two
// processes (docs/hosted-tenant-isolation.md "Step 2"): this one stays root
// and only starts and stops workers (spawnerMain.ts), and starts this file
// again as a uid that is not root to be the gateway (main.ts).

import { readConfig } from "./config";
import { generateMasterKey } from "./crypto";
import { runDemo } from "./demo";
import { runReadOnly } from "./readOnly";
import { workerIsolation } from "./spawner";
import { SPAWNER_KEY_ENV } from "./spawnerSocket";
import { isDemoMode } from "../server/demoMode";
import { isReadOnlyMode } from "../server/readOnlyMode";

if (process.argv[2] === "genkey") {
  console.log(generateMasterKey());
  process.exit(0);
}

if (process.argv[2] === "probe") {
  const { checkSandbox, describeCheck, sandboxFailures } = await import("./sandboxCheck");
  try {
    const check = await checkSandbox();
    console.log(describeCheck(check));
    process.exit(sandboxFailures(check).length ? 1 : 0);
  } catch (e) {
    console.log(`the workers' confinement could not be tried: ${(e as Error).message}`);
    process.exit(1);
  }
}

// A DEMO_MODE service built from this image is the public demo, not the gateway.
if (isDemoMode()) await runDemo();
// A SPECDRIVEN_READONLY service is the public read-only spec site (readOnly.ts).
if (isReadOnlyMode()) await runReadOnly();

const config = readConfig();
// The spawner's key is what marks the process it started as the gateway.
if (!process.env[SPAWNER_KEY_ENV] && workerIsolation()) {
  await (await import("./spawnerMain")).runSpawner(config);
} else {
  await (await import("./main")).runGateway(config);
}
