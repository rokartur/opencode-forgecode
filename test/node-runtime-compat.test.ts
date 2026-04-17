import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function runNode(script: string) {
  return spawnSync("node", ["-e", script], {
    cwd: rootDir,
    encoding: "utf-8",
  });
}

describe("Node runtime compatibility", () => {
  beforeAll(() => {
    const result = spawnSync("npm", ["run", "build"], {
      cwd: rootDir,
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
  });

  test("bundled server imports under Node", () => {
    const result = runNode(`
      import('./dist/index.js')
        .then(() => console.log('node-index-ok'))
        .catch((err) => {
          console.error(err)
          process.exit(1)
        })
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("node-index-ok");
    expect(result.stderr).not.toContain("ERR_UNSUPPORTED_DIR_IMPORT");
  });

  test("bundled server initializes plugin under Node with graph enabled", () => {
    const result = runNode(`
      import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { createForgePlugin } from './dist/index.js';

      const dir = mkdtempSync(join(tmpdir(), 'oc-forge-node-'));
      writeFileSync(join(dir, 'index.ts'), 'export const x = 1\\n');

      try {
        const plugin = createForgePlugin({ graph: { enabled: true, autoScan: true, watch: false } });
        const hooks = await plugin({
          directory: dir,
          worktree: dir,
          client: {},
          project: { id: 'node-smoke-project' },
          serverUrl: new URL('http://localhost:5551'),
          $: {},
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));
        console.log('node-plugin-graph-init-ok');
        if (typeof hooks.getCleanup === 'function') await hooks.getCleanup();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("node-plugin-graph-init-ok");
  });
});
