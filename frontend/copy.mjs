import { copyFile } from "node:fs/promises";
await Promise.all(["index.html", "brand.svg"].map(file => copyFile("src/" + file, "dist/" + file)));
