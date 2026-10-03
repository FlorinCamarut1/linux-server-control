// Lists the texts a catalog lacks, as JSON to translate:
//   node scripts/i18n-missing.mjs ro > /tmp/ro-missing.json
import { readFileSync } from "node:fs";
import { extract } from "./i18n-extract.mjs";
const language = process.argv[2];
const catalog = JSON.parse(readFileSync(new URL(`../src/lib/locales/${language}.json`, import.meta.url), "utf8"));
const { texts, plurals } = extract();
const missing = {};
for (const key of texts.keys()) if (!(key in catalog)) missing[key] = "";
for (const key of plurals.keys()) if (!(key in catalog)) missing[key] = { one: "", other: "" };
console.log(JSON.stringify(missing, null, 1));
