// Leaf module (no imports) so the registry can validate RunPod endpoint IDs without an import
// cycle through providers.mjs. providers.mjs re-exports this same regex.
export const RUNPOD_ENDPOINT_ID = /^[a-z0-9]{8,40}$/;
