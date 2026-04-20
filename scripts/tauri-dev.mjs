import { spawnSync } from "node:child_process";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";

const forwardedArgs = process.argv.slice(2);
const cargoTargetBaseDir = process.env.CARGO_TARGET_DIR ?? path.join(process.env.LOCALAPPDATA ?? "", "memorylane", "cargo-target");
const isDevCommand = forwardedArgs[0] === "dev";
const cargoTargetDir = isDevCommand
  ? path.join(cargoTargetBaseDir, `dev-${Date.now()}-${process.pid}`)
  : cargoTargetBaseDir;
const memorylaneExePath = path.join(cargoTargetDir, "debug", "memorylane.exe");

process.env.CARGO_TARGET_DIR = cargoTargetDir;

await mkdir(cargoTargetDir, { recursive: true });

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const staleProcessNames = ["memorylane.exe", "memorylane_lib.exe"];

async function clearStaleExecutable() {
  if (process.platform !== "win32") {
    return;
  }

  for (const processName of staleProcessNames) {
    spawnSync("taskkill", ["/F", "/T", "/IM", processName], {
      stdio: "ignore",
    });
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await unlink(memorylaneExePath);
      return;
    } catch (error) {
      if (error?.code === "ENOENT") {
        return;
      }

      if (attempt === 19) {
        return;
      }

      await delay(250);
    }
  }
}

await clearStaleExecutable();

const isWindows = process.platform === "win32";
const cliCommand = isWindows ? "cmd.exe" : "tauri";
const cliArgs = isWindows ? ["/d", "/s", "/c", "tauri", ...forwardedArgs] : forwardedArgs;

const result = spawnSync(cliCommand, cliArgs, {
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
