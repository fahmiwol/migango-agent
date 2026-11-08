import { validateRunpodFields } from "./model-registry.mjs";
export function chooseRoute(settings, mode) {
  const provider =
    settings.routes?.[mode === "ask" ? "light" : "coding"] || settings.active;
  if (!["openai", "anthropic", "kimi", "ollama", "runpod"].includes(provider))
    throw new Error("Select a supported provider in Settings");
  const profile = settings.profiles[provider];
  if (!profile?.model?.trim())
    throw new Error("Enter an exact model ID in Settings");
  // RunPod stays inactive until the owner fills in a valid endpointId.
  if (provider === "runpod") validateRunpodFields({ ...profile, provider });
  return { provider, ...profile };
}
export function fitContext(messages, maxChars = 48000) {
  const size = new TextEncoder().encode(JSON.stringify(messages)).length;
  if (size > maxChars)
    throw new Error(
      `Context budget reached (${size}/${maxChars} bytes). Start a focused follow-up with the result summary.`,
    );
  return messages;
}
