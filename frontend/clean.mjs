import { mkdir, readdir, rm } from "node:fs/promises";
await mkdir("dist", { recursive: true });
for (const file of await readdir("dist")) {
  if (file !== ".gitkeep") await rm("dist/" + file, { recursive: true, force: true });
}
