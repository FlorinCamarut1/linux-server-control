// Lists the texts src/ marks for translation with t(), tn() and msg().
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
function sources(folder) {
  return readdirSync(folder).flatMap((name) => {
    const file = path.join(folder, name);
    if (statSync(file).isDirectory()) return sources(file);
    return /\.tsx?$/.test(name) ? [file] : [];
  });
}
const STRING = String.raw`"((?:[^"\\]|\\.)*)"`;
export function extract() {
  const texts = new Map(), plurals = new Map(), dynamic = [];
  for (const file of sources(path.join(root, "src"))) {
    const code = readFileSync(file, "utf8");
    const where = path.relative(root, file);
    for (const match of code.matchAll(new RegExp(String.raw`\b(?:t|msg)\(\s*${STRING}`, "g"))) texts.set(JSON.parse(`"${match[1]}"`), where);
    for (const match of code.matchAll(new RegExp(String.raw`\btn\(\s*${STRING}`, "g"))) plurals.set(JSON.parse(`"${match[1]}"`), where);
    for (const match of code.matchAll(/\b(?:t|tn|msg)\(\s*`/g)) dynamic.push(`${where}: ${code.slice(match.index, match.index + 40)}`);
  }
  return { texts, plurals, dynamic };
}
