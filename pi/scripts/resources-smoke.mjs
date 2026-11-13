// Load the real package with Pi's SDK, without reading user state or sending a model request.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "agent-resources-"));
// Set before importing the SDK: resource discovery must never visit the real HOME.
process.env.HOME = root;
process.env.PI_CODING_AGENT_DIR = join(root, ".pi/agent");
process.env.PI_OFFLINE = "1";
try {
  await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  const { DefaultResourceLoader, SettingsManager, ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const shared = join(packageRoot, "../config/pi");
  const settings = JSON.parse(await readFile(join(shared, "settings.json"), "utf8"));
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: process.env.PI_CODING_AGENT_DIR,
    settingsManager: SettingsManager.inMemory({ ...settings, packages: [packageRoot] }),
    noContextFiles: true,
  });
  await loader.reload();
  const extensions = loader.getExtensions();
  assert.deepEqual(extensions.errors, [], "Pi extension load errors");
  const expected = (await readdir(join(packageRoot, "extensions"))).filter(name => name.endsWith(".ts"));
  assert.equal(extensions.extensions.length, expected.length, "All declared extensions must load");
  for (const result of [loader.getSkills(), loader.getPrompts(), loader.getThemes()]) {
    assert.deepEqual(result.diagnostics, [], "Resource diagnostics");
  }
  assert.equal(loader.getSkills().skills.length, 5);
  assert.equal(loader.getPrompts().prompts.length, 3);
  assert.equal(loader.getThemes().themes.length, 3);
  const runtime = await ModelRuntime.create({
    modelsPath: join(shared, "models.json"),
    authPath: join(root, "auth.json"),
    modelsStorePath: join(root, "models-store.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  assert.equal(runtime.getError(), undefined, "Pi model schema and provider composition");
  for (const reference of [
    `${settings.defaultProvider}/${settings.defaultModel}`,
    ...settings.enabledModels,
    settings.webSearch.model,
  ]) {
    const slash = reference.indexOf("/");
    assert.ok(runtime.getModel(reference.slice(0, slash), reference.slice(slash + 1)), `Missing model ${reference}`);
  }
  console.log(`PASS: ${expected.length} extensions, 5 skills, 3 prompts, 3 themes and configured models load with Pi; no network or user state.`);
} finally {
  await rm(root, { recursive: true, force: true });
}
