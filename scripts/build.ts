import { readFileSync, writeFileSync, cpSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import solidPlugin from "@opentui/solid/bun-plugin";

const rootDir = join(__dirname, "..");
const packageJsonPath = join(rootDir, "package.json");
const distDir = join(rootDir, "dist");

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
  version?: string;
};
const buildVersion = packageJson.version ?? "0.0.0";

console.log("Cleaning dist...");
rmSync(distDir, { recursive: true, force: true });

console.log("Generating type declarations...");
execSync("tsc -p tsconfig.build.json --emitDeclarationOnly", {
  cwd: rootDir,
  stdio: "inherit",
});

console.log("Bundling server plugin...");
const serverResult = await Bun.build({
  entrypoints: [join(rootDir, "src", "index.ts")],
  outdir: distDir,
  target: "node",
  format: "esm",
  naming: "index.js",
  external: ["@opencode-ai/plugin", "@opencode-ai/sdk", "@opencode-ai/sdk/v2", "better-sqlite3"],
  define: {
    __FORGECODE_VERSION_VALUE__: JSON.stringify(buildVersion),
  },
});

console.log("Compiling TUI plugin...");
const tuiResult = await Bun.build({
  entrypoints: [join(rootDir, "src", "tui.tsx")],
  outdir: distDir,
  target: "node",
  format: "esm",
  plugins: [solidPlugin],
  external: [
    "@opencode-ai/plugin/tui",
    "@opentui/core",
    "@opentui/solid",
    "solid-js",
    "better-sqlite3",
  ],
  define: {
    __FORGECODE_VERSION_VALUE__: JSON.stringify(buildVersion),
  },
});

console.log("Bundling graph worker...");
const workerResult = await Bun.build({
  entrypoints: [join(rootDir, "src", "graph", "worker.ts")],
  outdir: join(distDir, "graph"),
  target: "node",
  format: "esm",
  // web-tree-sitter ships emscripten glue with WASI imports (clock_time_get, etc.).
  // Bundling it through Bun mangles the dynamic require/locateFile machinery and
  // strips the WASI shim, producing:
  //   LinkError: import function wasi_snapshot_preview1:clock_time_get must be callable
  // Keep it external so Node loads the package's runtime as-is.
  external: ["web-tree-sitter", "tree-sitter-wasms", "better-sqlite3"],
});

for (const result of [serverResult, tuiResult, workerResult]) {
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }
}

console.log("Generating TUI type declarations...");
const tuiDtsContent = `import type { TuiPluginModule } from '@opencode-ai/plugin/tui';
declare const plugin: TuiPluginModule & { id: string };
export default plugin;
`;
writeFileSync(join(distDir, "tui.d.ts"), tuiDtsContent, "utf-8");

console.log("Copying template files...");
const srcTemplateDir = join(rootDir, "src", "command", "template");
const distTemplateDir = join(distDir, "command", "template");
mkdirSync(distTemplateDir, { recursive: true });
cpSync(srcTemplateDir, distTemplateDir, { recursive: true });

console.log("Build complete!");
