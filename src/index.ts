import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { registerReview } from "./register.ts";
import { Semaphore } from "./semaphore.ts";

export default function reviewGate(pi: ExtensionAPI): void {
  registerReview(pi, { gate: new Semaphore(loadConfig().maxConcurrency) });
}
