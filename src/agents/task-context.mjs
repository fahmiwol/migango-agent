// Task context (PRD-013 prelude + PRD-017 skill list), built for one provider. The parent run and
// every team child use this same path (PRD-018, ARS-008 step 1), each for its own provider and
// task, with receipts written to the caller's own event log.
import { buildPrelude, preludeBudgetFor } from "./prelude.mjs";
import { buildSkillBlock, skillBudgetFor } from "./skill-router.mjs";
import { safeErrorCode } from "../core/safe-error.mjs";

const skillsOff = { type: "skills", status: "disabled", included: [], dropped: [], chars: 0 };

// Below this many characters a prelude carries too little to be worth its bytes.
const MIN_CONTEXT_CHARS = 400;

/**
 * Returns { prelude, skillBlock }. `prelude` alone is the stable, cacheable prefix.
 * `maxChars` caps prelude + skill list when the request has little room (Ollama children);
 * `readable` false omits read_file hints for agents that cannot read.
 */
export async function buildTaskContext({ store, router, workspace, provider, prompt, event, maxChars = Infinity, readable = true }) {
  const redact = (text) => store.redact(text);
  if (store.settings.internalMemory === false) {
    await event({ type: "prelude", status: "disabled", files: [], chars: 0, tokensEstimate: 0 });
    if (router) {
      router.forget?.();
      await event(skillsOff);
    }
    return { prelude: "", skillBlock: "" };
  }
  const totalChars = Math.min(preludeBudgetFor(provider), Math.max(0, Math.floor(maxChars)));
  if (totalChars < MIN_CONTEXT_CHARS) {
    await event({ type: "prelude", status: "skipped", reason: "ruang adapter", files: [], chars: 0, tokensEstimate: 0, budgetChars: totalChars });
    if (router) await event({ ...skillsOff, status: "skipped", reason: "ruang adapter" });
    return { prelude: "", skillBlock: "" };
  }
  // The skill index comes first so its fixed share of the prelude budget is reserved only when
  // the project actually has skills.
  let skillIndex = null;
  if (router && store.settings.skillRouter === false) {
    router.forget?.();
    await event(skillsOff);
  } else if (router)
    try {
      // Outside sources only ever see the redacted prompt.
      skillIndex = await router.index(workspace, { prompt: redact(prompt) });
    } catch (error) {
      await event({
        type: "skills",
        status: "unavailable",
        reason: "skill index failed",
        ...safeErrorCode(error),
        included: [],
        dropped: [],
        chars: 0,
      });
    }
  // Keyed on local skills only: outside candidates depend on the prompt, and the cached
  // project-file block must not.
  // At most a fifth of a shrunken allowance goes to skills; the default sizes are unchanged.
  const reserveChars = skillIndex?.skills.some((s) => s.path)
    ? Math.min(skillBudgetFor(provider), Math.floor(totalChars / 5))
    : 0;
  const built = await buildPrelude({ root: workspace, provider, redact, reserveChars, totalChars });
  await event({ type: "prelude", ...built.receipt });
  let skillBlock = "";
  if (skillIndex) {
    const ranked = skillIndex.skills.length ? router.rank(prompt, skillIndex.skills) : { chosen: [], dropped: [] };
    const block = buildSkillBlock({ chosen: ranked.chosen, provider, redact, budget: reserveChars, readable });
    skillBlock = block.text;
    const allDropped = [...block.dropped, ...ranked.dropped];
    const droppedCounts = {};
    for (const d of allDropped) droppedCounts[d.reason] = (droppedCounts[d.reason] || 0) + 1;
    await event({
      type: "skills",
      status: !skillIndex.skills.length ? "empty" : block.included.length ? "ok" : "none",
      indexed: skillIndex.skills.length,
      included: block.included,
      // Highest scores first, zero scores left out (counted in droppedCounts); at most ten.
      dropped: allDropped.filter((d) => d.score > 0).slice(0, 10),
      droppedCounts,
      skipped: skillIndex.skipped.slice(0, 20),
      sources: skillIndex.sources,
      chars: skillBlock.length,
      budgetChars: reserveChars,
    });
  }
  return { prelude: built.text, skillBlock };
}

/**
 * First user message: context, then the label, then the request; prelude stays cacheable.
 * `label` names who wrote the request; children use the owner label only while their task is the
 * owner's own prompt.
 */
export function firstMessage({ prelude, skillBlock, prior = "", request, tail = "", label = "Owner request:\n" }) {
  const message = {
    role: "user",
    content: prelude + skillBlock + prior + (prelude || skillBlock ? label : "") + request + tail,
  };
  // Non-enumerable, so JSON-based size checks (fitContext, compaction, guards) never count it twice.
  if (prelude) Object.defineProperty(message, "cachePrefix", { value: prelude, enumerable: false });
  return message;
}

/** Bytes resent with every turn (prelude + skill list); reported, not charged to input shares. */
export const resentBytes = ({ prelude, skillBlock }) =>
  prelude || skillBlock ? Buffer.byteLength(JSON.stringify(prelude + skillBlock)) - 2 : 0;
