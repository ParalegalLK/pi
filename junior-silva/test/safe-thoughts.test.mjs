import assert from "node:assert/strict";
import test from "node:test";
import { safeProgressName } from "../server/openai.mjs";

test("LibreChat thought labels are static and do not reflect raw tool input or output", () => {
	const rawNames = [
		"mcp__junior_silva_legal__legal_source_retrieve_details",
		"bash",
		"read_file",
		"write",
		"unrecognized-tool-with-a-secret-like-name",
	];
	const labels = rawNames.map(safeProgressName);
	for (const label of labels) {
		assert.match(label, /…$/);
		assert.doesNotMatch(label, /api[_-]?key|token|https?:|\/app\/|bash/i);
	}
	assert.equal(labels[0], "Retrieving an underlying Sri Lankan legal source…");
	assert.equal(labels[1], "Preparing the requested legal work product…");
});
