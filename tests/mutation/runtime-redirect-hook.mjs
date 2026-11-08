// Loader hook for mutation runs: resolves the module named by MUTANT_TARGET (a path suffix,
// default /src/agents/runtime.mjs) to the mutant file named by MUTANT_RUNTIME.
// Use: node --import ./tests/mutation/runtime-redirect-hook.mjs <test file>
import { register } from "node:module";
import { isMainThread } from "node:worker_threads";
import { pathToFileURL } from "node:url";

let target = null,
  suffix = "/src/agents/runtime.mjs";
export function initialize(data) {
  target = data.url;
  suffix = data.suffix;
}
export async function resolve(specifier, context, next) {
  const result = await next(specifier, context);
  if (target && result.url.endsWith(suffix) && context.parentURL !== target)
    return { ...result, url: target };
  return result;
}
if (isMainThread && process.env.MUTANT_RUNTIME)
  register(import.meta.url, {
    data: {
      url: pathToFileURL(process.env.MUTANT_RUNTIME).href,
      suffix: process.env.MUTANT_TARGET || "/src/agents/runtime.mjs",
    },
  });
