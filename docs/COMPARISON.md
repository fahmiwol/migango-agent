# miganGO vs other AI agents

*Checked 2026-11-09. Every competitor cell cites a source below; "unverified" means we could not confirm it
from a primary page. Star counts are from the GitHub API on that date and are a weak usage signal
(the AI-tooling corner of GitHub has a documented fake-star problem [S41]). Corrections welcome — open an
issue with a link.*

## The short version

miganGO is **not** trying to out-feature opencode, Claude Code or OpenClaw. It is a small, opinionated agent
for people who:

1. want their **default model to be a cheap local one on their own hardware** (even a CPU-only mini PC),
2. want a **hard, built-in daily spend cap per provider** — not an estimate, not an external gateway,
3. never want the agent to **silently** move their data to a paid cloud model, and
4. would rather read the UI in **Bahasa Indonesia**.

If you want the biggest ecosystem, use opencode, Claude Code, Codex or OpenClaw. If one of the four lines
above is the thing that keeps you up at night, read on.

## Comparison table

| | **miganGO** | opencode | Cursor | Claude Code / Desktop | OpenAI Codex | Hermes Agent (+ dashboard) | OpenClaw | Cline |
|---|---|---|---|---|---|---|---|---|
| Licence | **MIT** | MIT [S1] | Proprietary | No licence on repo [S5] | Apache-2.0 [S4] | MIT [S2] | MIT [S3] | Apache-2.0 [S6] |
| Stars (2026-11-09) | new | 225,475 | closed | 154,983 | 133,774 | 261,688 | 394,197 | 71,463 |
| Form | Desktop (Electron) + local HTTP bridge + MCP | TUI, desktop, web [S14] | IDE + cloud agents | CLI, IDE, desktop, web, mobile [S15] | CLI, IDE, desktop, web [S22] | TUI, desktop, messaging, web dashboard [S25][S26] | Gateway, chat apps, native, web [S29] | CLI, desktop, VS Code, JetBrains [S38] |
| BYOK | Anthropic, OpenAI, Kimi, Gemini, RunPod, Ollama | Yes [S12] | Limited [S11] | Anthropic family only [S17] | Sign-in / API key [S21] | Many [S27] | Yes [S29] | Yes [S38] |
| Local models | **Default route**; CPU-only box over WireGuard | Ollama, LM Studio, vLLM [S12] | Not official [S11] | Not documented [S17] | Unverified [S23] | Yes, needs ≥64K ctx [S27] | Ollama [S30] | Ollama, LM Studio [S38] |
| Cloud fallback when local is down | **Stops and asks — per task, one click** | Unverified | n/a | `--fallback-model` (automatic) [S19] | Unverified | `fallback_providers` (automatic) [S27] | Per-job fallbacks [S32] | Unverified |
| **Hard per-provider spend cap, built in** | **Yes — daily USD per provider + 2M tokens/day, locked reservations** | None documented [S13] | Caps on 3rd-party usage [S9] | `--max-budget-usd`, print mode, estimate, can overshoot [S19] | Plan limits / credits [S21] | MCP `spend_limit` only [S28] | Unverified | Unverified |
| Approval model | Exact-args, one-time, 120 s, actor-bound; authority = ∩ of 5 sets; tiered shell classifier | allow/ask/deny rules [S13] | Unverified | Per-tool prompts, rules, auto mode [S18] | Sandbox × approval matrix [S24] | smart/manual/off, deny on timeout [S28] | Pairing + tool policy [S29][S33] | Approve unless auto-approve [S38] |
| Crash recovery | **Journal; uncertain effects held, never replayed** | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified | Unverified |
| Persistent memory | Workspace SQLite + optional external brain via MCP | Unverified | Unverified | CLAUDE.md + auto memory [S20] | "Memories" [S23] | Agent-curated + FTS5 [S25] | Markdown + SQLite [S31] | `.clinerules` |
| Privacy taint (private memory ⇒ local-only chat) | **Designed & tested on a branch; not in main yet** | Not found | Not found | Not found | Not found | Not found | Not found | Not found |
| Independent pre-deploy verifier | **Clean-clone GATE + evidence seal** (ops scripts) | Not found | Not found | Hooks can block [S20] | Security scanning product [S24] | Not found | Not found | Not found |
| Scheduled agents | Headless multi-round runner | Unverified | Automations (Premium) [S9] | Cloud/desktop tasks, `/loop` [S15] | Scheduled tasks [S23] | Built-in cron [S25] | Cron [S32] | Cron agents [S38] |
| MCP | Client (allow-listed, exact approval) + server bridge | Yes [S14] | Yes [S10] | Yes [S15] | Yes [S23] | Yes [S25] | Client + server [S34] | Yes [S38] |
| Self-host | Fully local | Binary / Docker [S14] | No | Gateway [S17] | CLI local [S21] | 6 backends [S25] | Yes | Local |
| Price | Free | Free; Go $10/mo [S14] | Free → $200/mo [S9] | Free → $200/mo [S16] | Free → $500/mo [S21] | Free [S35] | Free [S29] | Unverified |
| Bahasa Indonesia UI | **Yes (first language)** | No (22 README langs, no ID) [S43] | Unverified | Unverified | Unverified | Not listed [S26] | Not found | No [S44] |
| Platform | **Windows only (today)** | Cross-platform | Cross-platform | Cross-platform | Cross-platform | Cross-platform | Cross-platform | Cross-platform |

## Where miganGO is behind (please help)

- **Windows only.** The sandbox uses AppContainer and Windows Job Objects. macOS/Linux need equivalents.
- **Tiny community, zero stars.** Every other row has years of contributors.
- **No image route adapter, no RAG module** (specs exist, code does not).
- **The privacy-taint lock and the owner web allow-list** were designed and tested on branches but are not merged.
- **Test baseline:** a clean-clone run has historically shown pre-existing failures (native helpers); see `docs/09-log`.

## Sources

S1 api.github.com/repos/sst/opencode (→ anomalyco/opencode) · S2 api.github.com/repos/NousResearch/hermes-agent ·
S3 api.github.com/repos/openclaw/openclaw · S4 api.github.com/repos/openai/codex · S5 api.github.com/repos/anthropics/claude-code ·
S6 api.github.com/repos/cline/cline · S9 cursor.com/pricing · S10 cursor.com/docs · S11 docs.cursor.com/settings/api-keys ·
S12 opencode.ai/docs/providers · S13 opencode.ai/docs/permissions · S14 opencode.ai/docs · S15 code.claude.com/docs/en/overview ·
S16 claude.com/pricing · S17 code.claude.com/docs/en/third-party-integrations · S18 code.claude.com/docs/en/permissions ·
S19 code.claude.com/docs/en/cli-reference · S20 code.claude.com/docs/en/memory · S21 learn.chatgpt.com/docs/pricing ·
S22 github.com/openai/codex README · S23 learn.chatgpt.com/docs/codex/cli · S24 learn.chatgpt.com/docs/agent-approvals-security ·
S25 github.com/NousResearch/hermes-agent README · S26 hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard ·
S27 hermes-agent.nousresearch.com/docs/integrations/providers · S28 hermes-agent.nousresearch.com/docs/user-guide/security ·
S29 github.com/openclaw/openclaw README · S30 docs.openclaw.ai/providers/ollama · S31 docs.openclaw.ai/concepts/memory ·
S32 docs.openclaw.ai/automation/cron-jobs · S33 docs.openclaw.ai/gateway/security · S34 docs.openclaw.ai/cli/mcp ·
S35 docs.openclaw.ai/start/why-openclaw/openclaw-and-hermes-agent · S38 github.com/cline/cline README ·
S41 glukhov.org / finisky.github.io / oosmetrics.com (secondary) · S43 github.com/anomalyco/opencode README · S44 cline README.
All accessed 2026-11-09.
