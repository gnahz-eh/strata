import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";

async function discover(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await discover(path));
    else if (entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files;
}

const child = spawn(process.execPath, ["--import", "tsx", "--test", ...process.argv.slice(2), ...(await discover("tests")).sort()], { stdio: "inherit" });
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });