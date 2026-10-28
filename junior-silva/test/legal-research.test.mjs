import assert from "node:assert/strict";
import test from "node:test";
import {
	authorityCandidates,
	enrichAuthorityAliases,
	linkedAuthorities,
	linkifyCitedAuthorities,
	mergeAuthorityCandidates,
	researchDelivery,
} from "../core/legal-research.mjs";

const ANSWER = `## Position\n\n*Case A* ([1-nlr-1](https://lex.example/1.pdf)) and *Case B* ([2-nlr-2](https://lex.example/2.pdf)) apply.`;

test("linkedAuthorities retains unique Markdown authority links", () => {
	assert.deepEqual(linkedAuthorities(`${ANSWER}\n[1-nlr-1](https://lex.example/1.pdf)`), [
		{ label: "1-nlr-1", url: "https://lex.example/1.pdf" },
		{ label: "2-nlr-2", url: "https://lex.example/2.pdf" },
	]);
});

test("researchDelivery marks direct research for verbatim delivery", () => {
	const delivery = researchDelivery(ANSWER);
	assert.equal(delivery.mode, "direct_answer");
	assert.equal(delivery.linked_authorities.length, 2);
	assert.match(delivery.instruction, /verbatim/i);
});

test("citation delivery links cited authorities without appending unused RAG sources", () => {
	const authorities = mergeAuthorityCandidates([], enrichAuthorityAliases(
		"*Mackinnon Mackenzie Co. v. Grindlays Bank Ltd.* ([1986/v2-sri-lr-272](https://lex.example/mackinnon.pdf))",
		authorityCandidates([
			{ label: "1986/v2-sri-lr-272", url: "https://lex.example/mackinnon.pdf" },
			{ label: "20-nlr-60", url: "https://lex.example/unused.pdf" },
		]),
	));
	const delivered = linkifyCitedAuthorities("The applicable principle appears in Mackinnon Mackenzie Co. v. Grindlays Bank Ltd.", authorities);
	assert.match(delivered, /\[Mackinnon Mackenzie Co\. v\. Grindlays Bank Ltd\.\]\(https:\/\/lex\.example\/mackinnon\.pdf\)/);
	assert.doesNotMatch(delivered, /unused\.pdf|Linked authorities supporting this draft/);
});
