import { expect, test } from "bun:test";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("database bootstraps a missing nested data directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "training-db-test-"));
  try {
    const dataDir = join(dir, "new", "data");
    const result = Bun.spawnSync([process.execPath, "run", "src/db.ts"], {
      cwd: root, env: { ...process.env, DATA_DIR: dataDir }, stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(dataDir, "training.db"))).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
