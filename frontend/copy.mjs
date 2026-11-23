import { copyFile } from "node:fs/promises";
await copyFile("src/index.html", "dist/index.html");
