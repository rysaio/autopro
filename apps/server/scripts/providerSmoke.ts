import { getConfig } from "../src/config.js";
import { runProviderToolSmoke } from "./providerToolSmoke.js";

const config = getConfig();

console.log(JSON.stringify(await runProviderToolSmoke(config, { forceLive: true }), null, 2));
