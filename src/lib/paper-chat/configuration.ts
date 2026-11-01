import { createHash } from "node:crypto";
import { aiConfiguration } from "../ai";
import type { PaperChatConfiguration } from "./types";

export function publicPaperChatConfiguration(): PaperChatConfiguration {
  const config = aiConfiguration();
  return {
    provider: config.provider, model: config.model, configured: config.configured,
    remote: config.remote, credentialConfigured: config.credentialConfigured,
    environmentOverride: config.environmentOverride, message: config.message,
    // A model preference belongs to this service configuration. Never include a
    // credential or expose the endpoint itself to the client as an identity key.
    preferenceKey: createHash("sha256").update(JSON.stringify([
      config.provider, config.endpoint, config.model, config.environmentOverride,
    ])).digest("hex"),
  };
}
