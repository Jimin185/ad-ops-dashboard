import { mockAdapter } from "./mock";
import { liveAdapter } from "./live";

// Production adapters will implement the same interface. Until credentials and
// account mappings are configured, the app deliberately stays in mock mode.
export function getAdapter() {
  return process.env.ADAPTER_MODE === "live" ? liveAdapter : mockAdapter;
}
