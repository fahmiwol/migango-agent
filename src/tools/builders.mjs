export function draftPackage(input) {
  const { kind, name } = input;
  if (
    !["skill", "tool", "bridge"].includes(kind) ||
    !/^([a-z0-9]+-)*[a-z0-9]+$/.test(name) ||
    name.length > 64
  )
    throw new Error("Invalid draft kind or safe package name");
  if (typeof input.description !== "string" || input.description.length > 1000)
    throw new Error("Draft description required");
  const manifest = {
    name,
    kind,
    status: "draft",
    activation: "manual-review-required",
    permissions: [],
    provenance: "agent-generated; not executed or trusted",
  };
  const base = "workbench-drafts/" + kind + "/" + name;
  let files;
  if (kind === "skill") {
    if (
      typeof input.instructions !== "string" ||
      input.instructions.length > 16000
    )
      throw new Error("Skill instructions required, <=16000 characters");
    files = [
      {
        path: base + "/SKILL.md",
        content: `---\nname: ${name}\ndescription: ${JSON.stringify(input.description)}\nmetadata:\n  status: draft\n  activation: manual-review-required\n---\n\n${input.instructions}\n`,
      },
    ];
  } else {
    if (
      typeof input.source !== "string" ||
      input.source.length > 48000 ||
      typeof input.testSource !== "string" ||
      input.testSource.length > 24000 ||
      !input.inputSchema ||
      typeof input.inputSchema !== "object"
    )
      throw new Error(
        "Tool/bridge requires bounded source, tests and input schema",
      );
    manifest.inputSchema = input.inputSchema;
    files = [
      {
        path: base + "/manifest.json",
        content: JSON.stringify(manifest, null, 2),
      },
      { path: base + "/index.mjs", content: input.source },
      { path: base + "/test.mjs", content: input.testSource },
    ];
  }
  return { manifest, files };
}
