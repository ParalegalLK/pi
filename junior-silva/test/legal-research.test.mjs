import assert from "node:assert/strict";
import test from "node:test";
import { linkedAuthorities, researchDelivery } from "../core/legal-research.mjs";

const ANSWER = `## Position\n\n*Case A* ([1-nlr-1](https://lex.example/1.pdf)) and *Case B* ([2-nlr-2](https://lex.example/2.pdf)) apply.`;

test("linkedAuthorities retains unique Markdown authority links", () => {
	assert.deepEqual(linkedAuthorities(`${ANSWER}\n[1-nlr-1](https://lex.example/1.pdf)`), [
		{ label: "1-nlr-1", url: "https://lex.example/1.pdf" },
		{ label: "2-nlr-2", url: "https://lex.example/2.pdf" },
	]);
});

test("researchDelivery marks direct research for verbatim delivery", () => {
	const delivery = researchDelivery(ANSWER);
	assert.equal(delivery.mode, "verbatim_for_direct_research");
	assert.equal(delivery.linked_authorities.length, 2);
	assert.match(delivery.instruction, /verbatim/i);
});
