# Changelog

## 0.2.0-alpha — 2026-11-09 — first public snapshot

First open-source release (MIT). Published as a fresh snapshot of the private development line
(internal history, working notes and machine-specific evidence are not included).

- BYOK providers: Anthropic, OpenAI, Kimi, Gemini, RunPod, Ollama (local first)
- No silent provider switch; per-task cloud fallback only on owner action
- Per-provider daily spend caps + daily token cap with locked reservations
- Owner-gated tools: 5-set permission intersection, exact one-time approvals (120 s)
- Recovery journal that holds uncertain side effects instead of replaying them
- Fail-first self-improvement with pinned oracle and snapshot activation
- Eval harness with bootstrap confidence intervals; ~1,480 unit/integration test cases
