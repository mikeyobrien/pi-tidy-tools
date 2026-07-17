import assert from "node:assert/strict";
import test from "node:test";
import { buildToolBlock } from "../index.js";

const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");

const groupedFffResult = {
	content: [{
		type: "text",
		text: [
			"package.json",
			"  2: \"name\": \"pi-tidy\"",
			"  4: \"description\": \"pi-tidy tools\"",
			"",
			"packages/pi-tidy-core/package.json",
			"  2: \"name\": \"@mobrienv/pi-tidy-core\"",
			"",
			"packages/pi-tidy-subagents/package.json",
			"  2: \"name\": \"@mobrienv/pi-tidy-subagents\"",
			"  9: \"url\": \"https://example.test/pi-tidy-tools\"",
		].join("\n"),
	}],
};

test("managed scoped FFF grep counts distinct grouped files", () => {
	const collapsed = buildToolBlock("grep", { pattern: "pi-tidy", path: "package.json" }, groupedFffResult);
	assert.match(stripAnsi(collapsed[1]!), /5 matches in 3 files$/);

	const expanded = buildToolBlock("grep", { pattern: "pi-tidy", path: "package.json" }, groupedFffResult, { expanded: true });
	const expandedText = stripAnsi(expanded.join("\n"));
	for (const path of ["package.json", "packages/pi-tidy-core/package.json", "packages/pi-tidy-subagents/package.json"]) {
		assert.match(expandedText, new RegExp(`^  ${path.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}$`, "m"));
	}
});
