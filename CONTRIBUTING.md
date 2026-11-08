# Contributing to miganGO

Thanks for helping. miganGO is small and opinionated, so a few rules keep it that way.

## The five rules

1. **Red test first.** Every behaviour change starts with a test that fails on `main` and passes with your
   change. Put the failing output in the PR description.
2. **Safety controls get a mutation test.** If you touch approvals, permissions, spend caps, the shell
   classifier, path rules, recovery or the bridge, add a script under `tests/mutation/` that removes the
   control and proves your test turns red.
3. **No silent provider switch, ever.** A change that sends data to a different model than the one the
   owner chose, without an explicit per-task action, will be rejected.
4. **Honest status words.** Results are `responded`, `needs-validation`, `verification-failed` — never
   "passed" unless a verifier ran.
5. **No secrets, no personal paths.** Never commit keys, tokens, `.env` files, machine paths or real
   customer data. Use fixtures.

## Good first issues

| Label | Example |
|---|---|
| `i18n` | Translate UI strings to English (all text already uses i18n keys) |
| `platform` | macOS/Linux replacement for AppContainer + Job Objects |
| `providers` | Image adapter for the `visual` route |
| `memory` | Implement `src/rag/` from its README spec |
| `docs` | Screenshots / a demo GIF of the approval flow |

## Workflow

```powershell
npm ci
npm test            # must be green for the files you touched
npm run test:desktop
```

1. Fork, branch from `main`, keep PRs small (one idea per PR).
2. Describe *why* in the PR, link the red test, and list the files a reviewer should read first.
3. A maintainer or a trusted reviewer checks the diff against the rules above.

## Code of conduct

Be kind, be specific, assume good faith. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Bahasa Indonesia

Kontribusi dalam Bahasa Indonesia sangat diterima — issue, PR, dan diskusi boleh memakai bahasa Indonesia.
