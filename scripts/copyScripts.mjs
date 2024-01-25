/* eslint-disable no-undef */
/* eslint-disable no-console */
import { join } from "path";
import { mkdir, readdir, copyFile } from "fs/promises";
import { URL } from "url";

const __dirname = new URL(".", import.meta.url).pathname;

const copyScripts = async () => {
  const src = join(__dirname, "../src/loxone/scripts");
  const dest = join(__dirname, "../dist/loxone/scripts");

  await mkdir(dest, { recursive: true });

  const files = await readdir(src);

  for (const file of files) {
    await copyFile(join(src, file), join(dest, file));
  }
};

copyScripts().then(() => console.log("scripts copied"));
