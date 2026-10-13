import assert from "node:assert/strict";
import test from "node:test";
import { legalSourceDefinitions } from "../core/typesense-legal-sources.mjs";
import { lexLegislationFields, retrieveLexLegislationDetails } from "../core/lex-legislation-sources.mjs";

test("direct legal source retrieval exposes a fixed, bounded source and field contract", () => {
	assert.deepEqual(Object.keys(legalSourceDefinitions).sort(), ["book", "case_chunk", "case_decision", "legislation"]);
	assert.ok(legalSourceDefinitions.case_decision.fields.includes("decision_text"));
	assert.ok(legalSourceDefinitions.case_chunk.fields.includes("chunk_text"));
	assert.ok(legalSourceDefinitions.book.fields.includes("text"));
	assert.ok(legalSourceDefinitions.legislation.fields.includes("section_subsections"));
	assert.ok(!legalSourceDefinitions.case_decision.fields.includes("chunk_vec"));
	assert.ok(lexLegislationFields.includes("section_subsections"));
	assert.ok(lexLegislationFields.includes("amendments"));
	assert.ok(lexLegislationFields.includes("pdf_urls"));
});

test("legislation section discovery falls back to authoritative Act discovery when Lex interactive search is restricted", async () => {
	const originalFetch = globalThis.fetch;
	const oldUrl = process.env.JUNIOR_LEX_LEGISLATION_API_URL;
	const oldKey = process.env.JUNIOR_LEX_LEGISLATION_API_KEY;
	process.env.JUNIOR_LEX_LEGISLATION_API_URL = "https://lex.example.test";
	process.env.JUNIOR_LEX_LEGISLATION_API_KEY = "test-key";
	const requests = [];
	globalThis.fetch = async (input) => {
		requests.push(String(input));
		if (String(input).includes("/api/search")) return new Response('{"detail":"restricted"}', { status: 401 });
		return new Response(JSON.stringify({ items: [{ id: "legislation_C_145", title: "Consumer Affairs Authority Act", section_count: 77 }] }), { status: 200 });
	};
	try {
		const result = await retrieveLexLegislationDetails({ operation: "find", legislation_scope: "section", query: "unfair trade practices" });
		assert.equal(result.found, 1);
		assert.equal(result.records[0].record_id, "legislation_C_145");
		assert.equal(requests.length, 2);
		assert.match(requests[0], /\/api\/search/);
		assert.match(requests[1], /\/api\/legislations/);
	} finally {
		globalThis.fetch = originalFetch;
		if (oldUrl === undefined) delete process.env.JUNIOR_LEX_LEGISLATION_API_URL; else process.env.JUNIOR_LEX_LEGISLATION_API_URL = oldUrl;
		if (oldKey === undefined) delete process.env.JUNIOR_LEX_LEGISLATION_API_KEY; else process.env.JUNIOR_LEX_LEGISLATION_API_KEY = oldKey;
	}
});

test("legislation resolves an Act ID plus section number through its ordered full Act sections", async () => {
	const originalFetch = globalThis.fetch;
	const oldUrl = process.env.JUNIOR_LEX_LEGISLATION_API_URL;
	const oldKey = process.env.JUNIOR_LEX_LEGISLATION_API_KEY;
	process.env.JUNIOR_LEX_LEGISLATION_API_URL = "https://lex.example.test";
	process.env.JUNIOR_LEX_LEGISLATION_API_KEY = "test-key";
	const requests = [];
	globalThis.fetch = async (input) => {
		requests.push(String(input));
		return new Response(JSON.stringify({
			id: "legislation_C_145",
			title: "Consumer Affairs Authority Act",
			sections: [
				{ id: 41, section_number: "56", section_title: "Previous section", section_content: "Previous text" },
				{ id: 42, section_number: "57", section_title: "Target section", section_content: "Exact original section 57 text.", subsections: [{ id: "(1)", content: "A subsection." }] },
			],
		}), { status: 200 });
	};
	try {
		const result = await retrieveLexLegislationDetails({ operation: "retrieve", legislation_scope: "section", record_id: "legislation_C_145", section_number: "57", fields: ["legislation_id", "legislation_title", "section_number", "section_title", "section_content", "subsections"] });
		assert.equal(result.found, 1);
		assert.equal(result.records[0].record_id, 42);
		assert.equal(result.records[0].fields.legislation_id, "legislation_C_145");
		assert.equal(result.records[0].fields.section_number, "57");
		assert.equal(result.records[0].fields.section_content, "Exact original section 57 text.");
		assert.equal(requests.length, 1);
		assert.match(requests[0], /\/api\/legislations\/legislation_C_145$/);
	} finally {
		globalThis.fetch = originalFetch;
		if (oldUrl === undefined) delete process.env.JUNIOR_LEX_LEGISLATION_API_URL; else process.env.JUNIOR_LEX_LEGISLATION_API_URL = oldUrl;
		if (oldKey === undefined) delete process.env.JUNIOR_LEX_LEGISLATION_API_KEY; else process.env.JUNIOR_LEX_LEGISLATION_API_KEY = oldKey;
	}
});

test("legislation reconstructs a subsection-only provision for a complete exact-section response", async () => {
	const originalFetch = globalThis.fetch;
	const oldUrl = process.env.JUNIOR_LEX_LEGISLATION_API_URL;
	const oldKey = process.env.JUNIOR_LEX_LEGISLATION_API_KEY;
	process.env.JUNIOR_LEX_LEGISLATION_API_URL = "https://lex.example.test";
	process.env.JUNIOR_LEX_LEGISLATION_API_KEY = "test-key";
	globalThis.fetch = async () => new Response(JSON.stringify({
		id: "legislation_C_145",
		title: "Consumer Affairs Authority Act",
		sections: [{ id: 42, section_number: "57", section_title: "Power to call for information", section_content: "", subsections: [{ id: "(1)", content: "The Authority may require information." }, { id: "(2)", content: "Information must remain confidential." }] }],
	}), { status: 200 });
	try {
		const result = await retrieveLexLegislationDetails({ operation: "retrieve", legislation_scope: "section", record_id: "legislation_C_145", section_number: "57", fields: ["section_content", "subsections"] });
		assert.match(result.records[0].fields.section_content, /^\(1\) The Authority may require information\./);
		assert.match(result.records[0].fields.section_content, /\(2\) Information must remain confidential\./);
		assert.equal(result.records[0].fields.subsections.length, 2);
	} finally {
		globalThis.fetch = originalFetch;
		if (oldUrl === undefined) delete process.env.JUNIOR_LEX_LEGISLATION_API_URL; else process.env.JUNIOR_LEX_LEGISLATION_API_URL = oldUrl;
		if (oldKey === undefined) delete process.env.JUNIOR_LEX_LEGISLATION_API_KEY; else process.env.JUNIOR_LEX_LEGISLATION_API_KEY = oldKey;
	}
});

test("full four-section amendment is retained in source order and uses Lex service-key authentication", async () => {
	const originalFetch = globalThis.fetch;
	const oldUrl = process.env.JUNIOR_LEX_LEGISLATION_API_URL;
	const oldKey = process.env.JUNIOR_LEX_LEGISLATION_API_KEY;
	process.env.JUNIOR_LEX_LEGISLATION_API_URL = "https://lex.example.test";
	process.env.JUNIOR_LEX_LEGISLATION_API_KEY = "test-key";
	let requestHeaders;
	globalThis.fetch = async (_input, init) => {
		requestHeaders = init?.headers;
		return new Response(JSON.stringify({
			id: "legislation_T_97",
			title: "Twenty Second Amendment to the Constitution",
			sections: [1, 2, 3, 4].map((number) => ({ id: number, section_number: String(number), section_title: `Section ${number}`, section_content: `Original text ${number}.` })),
		}), { status: 200 });
	};
	try {
		const result = await retrieveLexLegislationDetails({ operation: "retrieve", record_id: "legislation_T_97", fields: ["title", "sections"] });
		assert.equal(result.records[0].fields.sections.length, 4);
		assert.deepEqual(result.records[0].fields.sections.map((section) => section.section_number), ["1", "2", "3", "4"]);
		assert.equal(requestHeaders["X-API-Key"], "test-key");
		assert.equal(requestHeaders.Authorization, undefined);
	} finally {
		globalThis.fetch = originalFetch;
		if (oldUrl === undefined) delete process.env.JUNIOR_LEX_LEGISLATION_API_URL; else process.env.JUNIOR_LEX_LEGISLATION_API_URL = oldUrl;
		if (oldKey === undefined) delete process.env.JUNIOR_LEX_LEGISLATION_API_KEY; else process.env.JUNIOR_LEX_LEGISLATION_API_KEY = oldKey;
	}
});
