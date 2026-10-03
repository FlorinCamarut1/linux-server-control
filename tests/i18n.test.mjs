// Every text the dashboard translates, in every language: each catalog in
// src/lib/locales has exactly the texts that src/ marks with t(), tn() and
// msg(), with the same {placeholders}, and the plural forms its language needs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extract } from "../scripts/i18n-extract.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANGUAGES = ["ro", "zh", "hi", "es", "ar", "fr", "bn", "pt", "ru", "ur"];

const placeholders = (text) => new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]));

test("translated texts are string literals, so that they can be listed", () => {
  assert.deepEqual(extract().dynamic, []);
});

for (const language of LANGUAGES) {
  test(`the ${language} catalog has every text and nothing else`, () => {
    const { texts, plurals } = extract();
    const catalog = JSON.parse(readFileSync(path.join(root, "src", "lib", "locales", `${language}.json`), "utf8"));
    const categories = new Intl.PluralRules(language).resolvedOptions().pluralCategories;
    const missing = [...texts.keys(), ...plurals.keys()].filter((key) => !(key in catalog));
    assert.deepEqual(missing, [], `missing in ${language}.json`);
    const unused = Object.keys(catalog).filter((key) => !texts.has(key) && !plurals.has(key));
    assert.deepEqual(unused, [], `not used anywhere, in ${language}.json`);
    for (const [key, value] of Object.entries(catalog)) {
      if (plurals.has(key)) {
        assert.equal(typeof value, "object", `${language}: "${key}" needs plural forms`);
        for (const category of categories) assert.equal(typeof value[category], "string", `${language}: "${key}" lacks the "${category}" form`);
        const allowed = new Set([...key.split("|").flatMap((form) => [...placeholders(form)]), "count"]);
        for (const form of Object.values(value))
          for (const name of placeholders(form)) assert.ok(allowed.has(name), `${language}: "${key}" uses {${name}}`);
        assert.ok(placeholders(value.other).has("count") || !key.split("|").at(-1).includes("{count}"), `${language}: "${key}" other form lacks {count}`);
      } else {
        assert.equal(typeof value, "string", `${language}: "${key}"`);
        assert.ok(value.trim(), `${language}: "${key}" is empty`);
        assert.deepEqual(placeholders(value), placeholders(key), `${language}: placeholders of "${key}"`);
      }
    }
  });
}
