# Test & trial results

All numbers below were produced by the project itself while it was being built (26 Oct – 9 Nov 2026).
Nothing is a vendor benchmark. Where a number comes from a private development branch, it says so.

## 1. Automated test suite

| Measure | Value |
|---|---|
| Test files | 214 (199 unit · 15 integration) |
| Test cases | ~1,480 (`node:test`) |
| Mutation scripts | 49 (each removes a safety control and must turn a test red) |
| This public snapshot, unit suite with native helpers **not** built (`npm ci --ignore-scripts`) | 205 files · 1,544 cases: **1,461 pass**, 75 fail, 7 cancelled |
| Same suite in clean-clone runs **with** native helpers built (`npm ci`) | 1,544 cases, **0 failures** (GATE, section 2) |

The 75 failures without native helpers are all in the files that need the C#/PowerShell helpers (sandbox,
recovery custody, native kit). Run a normal `npm ci` (it builds them) before `npm test`.

## 2. Independent verifier ("GATE") — clean-clone runs

Every candidate was checked by a **separate** reviewer session in a **fresh clone** (one `npm ci`, one
full suite, mutation tests on the claimed controls) before it could be deployed.

| Candidate | Scope | Suite | Failures | Mutation score | Verdict |
|---|---|---:|---:|---:|---|
| D3: explicit local choice never auto-switches to cloud; per-task cloud button | routing, fallback, UI binding | 1,487 | 0 | 10 / 11 | PASS with notes |
| S2: private-memory + task trace, local-only by default | memory privacy, redaction, prompt fencing | 1,498 | 0 | 18 / 18 | PASS with notes (after a first REJECT) |
| Billing-error fallback + home-server profile | provider errors, fallback order | 1,510 | 0 | 11 / 11 | PASS with notes |
| Integration tip (all of the above) | merge interaction | 1,544 | 0 new¹ | — | PASS with notes |
| Web allow-list for untrusted context (R1 + R2) | exfiltration paths, redaction | full | 0 | 11 / 11 | PASS with notes |
| Deploy gate: ancestry check (G3) | rollback safety | — | — | 24 / 24 | rollback-to-rejected case still open² |

¹ One intermittent test (process custody) failed once and passed 3/3 on rerun and on the base.
² Documented as an open issue; the deploy tooling is not part of this repo.

**This public snapshot is the integration tip** (D3 + S2 + billing-error fallback on top of the stable
line): every row above marked "PASS with notes" except R1 + R2 is included. The web allow-list (R1 + R2)
and the conversation-level privacy taint (designed, not yet verified) are **not** included. They are good
first contributions.

**What the REJECTs taught us** (kept because they are the interesting part):

- **Private memory leaked to a cloud model.** The memory feature was on by default and bypassed the
  "external memory off" switch. Redaction ran *after* truncation, so a key prefix could survive at the cut
  edge. The fix: off by default, redact before truncate, fence injected text as data, and add a red test
  for each.
- **A button that could never appear.** An error was thrown before the run existed, so the UI never
  received its code. The verifier proved it with a probe, and nothing had been testing it.
- **A silent rollback path.** The deploy gate didn't check ancestry, so a previously rejected commit
  could be redeployed. It was caught by the gate's own mutation tests.

## 3. Live smoke tests: local vs cloud

The standard smoke task makes the agent use one tool per turn: discover tools, list files, read one
file, answer in one sentence.

| Model | Where it ran | Result | Wall clock |
|---|---|---|---|
| `qwen3.5:4b` (Ollama) | CPU-only home mini PC, over a VPN | 4/4 turns PASS | ~20–22 s |
| `qwen3.5:4b`, primary address down | same box, fallback address | 4/4 turns PASS | ~20 s |
| Kimi K2.6 | cloud | 4/4 turns PASS | — |
| Claude Haiku 5.5 | cloud | skipped (account balance empty) | — |

## 4. Run-level comparison by model (own logs)

| Model | Runs | Spend (USD) | Blended $/1M tok | Median run (s) |
|---|---:|---:|---:|---:|
| Claude Opus 5.5 | 149 | 249.11 | 2.65 | 155.1 |
| Claude Sonnet 5.5 | 64 | 25.90 | 1.94 | 24.5 |
| Kimi K3.1 Pro | 26 | 9.55 | 0.67 | 407.5 |
| Claude Haiku 5.5 | 314 | 5.37 | 0.48 | 10.5 |
| Kimi K2.6 | 29 | 1.18 | 0.51 | 18.1 |
| qwen3.5:4b (home CPU) | 31 | 0.00 | 0 | 70.4 |
| qwen3:4b (home CPU) | 9 | 0.00 | 0 | 55.3 |

627 runs. "Median run" is wall clock for a whole multi-turn task including tools, not model latency.
Success rates are deliberately **not** shown: many runs were designed to fail (verifier and safety tests),
so a success percentage would mislead.

## 5. Reproduce

```powershell
npm ci
npm test               # unit + integration
npm run test:desktop   # Electron UI
node tests/mutation/<script>.mjs   # one mutation check; see tests/mutation/
```

The cost numbers come from `%APPDATA%/migan-workbench/costs/*.json`, which your own install writes as you
use it.
