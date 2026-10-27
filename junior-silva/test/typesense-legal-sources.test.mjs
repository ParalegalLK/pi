import assert from "node:assert/strict";
import test from "node:test";
import { legalSourceDefinitions, retrieveLegalSourceDetails } from "../core/typesense-legal-sources.mjs";
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

test("case catalogue resolves an indexed judge before applying judge, year, and subject filters", async () => {
	const originalFetch = globalThis.fetch;
	const previous = Object.fromEntries(["JUNIOR_TYPESENSE_ENABLED", "JUNIOR_TYPESENSE_DECISION_HOST", "JUNIOR_TYPESENSE_DECISION_API_KEY"].map((key) => [key, process.env[key]]));
	process.env.JUNIOR_TYPESENSE_ENABLED = "true";
	process.env.JUNIOR_TYPESENSE_DECISION_HOST = "decisions.example.test";
	process.env.JUNIOR_TYPESENSE_DECISION_API_KEY = "test-key";
	const requests = [];
	globalThis.fetch = async (input) => {
		const url = new URL(String(input));
		requests.push(url);
		if (url.searchParams.get("facet_by") === "judge_final") {
			return new Response(JSON.stringify({ facet_counts: [{ field_name: "judge_final", counts: [{ value: "Mahinda Samayawardhena, J.", count: 4 }, { value: "Other Judge, J.", count: 1 }] }] }), { status: 200 });
		}
		return new Response(JSON.stringify({
			found: 2,
			hits: [{ document: { primary_key: "case-1", standard_casenumber: "SC/Tax/1", nameofparties: "Commissioner General v Silva", summary_text: "A tax assessment decision.", keywords: ["tax"], judge_final: "Mahinda Samayawardhena, J.", decision_year: 2026, sc_or_ca: "SC", link: "https://lex.example/case-1" } }],
		}), { status: 200 });
	};
	try {
		const result = await retrieveLegalSourceDetails({ source: "case_decision", operation: "case_catalog", judge_name: "Mahinda Samayawardhena", decision_year: 2026, subject_query: "tax", page_size: 10 });
		assert.equal(requests.length, 2);
		assert.equal(requests[0].searchParams.get("q"), "*");
		assert.equal(requests[0].searchParams.get("filter_by"), "decision_year:=2026");
		assert.equal(requests[1].searchParams.get("q"), "tax");
		assert.equal(requests[1].searchParams.get("filter_by"), "judge_final:=`Mahinda Samayawardhena, J.` && decision_year:=2026");
		assert.equal(result.judge_resolution.status, "resolved");
		assert.equal(result.judge_resolution.value, "Mahinda Samayawardhena, J.");
		assert.equal(result.found, 2);
		assert.equal(result.has_more, false);
		assert.ok(result.requested_fields.includes("summary_text"));
		assert.ok(result.requested_fields.includes("link"));
		assert.equal(result.records[0].record_id, "case-1");
		assert.equal(result.records[0].fields.link, "https://lex.example/case-1");
	} finally {
		globalThis.fetch = originalFetch;
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	}
});

test("case catalogue resolves a unique minor judge spelling variant without asking the user", async () => {
	const originalFetch = globalThis.fetch;
	const previous = Object.fromEntries(["JUNIOR_TYPESENSE_ENABLED", "JUNIOR_TYPESENSE_DECISION_HOST", "JUNIOR_TYPESENSE_DECISION_API_KEY"].map((key) => [key, process.env[key]]));
	process.env.JUNIOR_TYPESENSE_ENABLED = "true";
	process.env.JUNIOR_TYPESENSE_DECISION_HOST = "decisions.example.test";
	process.env.JUNIOR_TYPESENSE_DECISION_API_KEY = "test-key";
	const requests = [];
	globalThis.fetch = async (input) => {
		requests.push(new URL(String(input)));
		if (!String(input).includes("facet_by")) return new Response(JSON.stringify({ found: 1, hits: [{ document: { primary_key: "case-1", standard_casenumber: "CA/1", nameofparties: "State v Person", summary_text: "Murder case", judge_final: "Sumudu Premachandra, J.", decision_year: 2026, link: "https://lex.example/case-1" } }] }), { status: 200 });
		return new Response(JSON.stringify({ facet_counts: [{ field_name: "judge_final", counts: [{ value: "Sumudu Premachandra, J.", count: 2 }, { value: "Sumudu Perera, J.", count: 1 }] }] }), { status: 200 });
	};
	try {
		const result = await retrieveLegalSourceDetails({ source: "case_decision", operation: "case_catalog", judge_name: "Sumudu Premachandr", decision_year: 2026, subject_query: "murder" });
		assert.equal(requests.length, 2);
		assert.equal(result.found, 1);
		assert.equal(result.judge_resolution.status, "resolved");
		assert.equal(result.judge_resolution.matched_by, "high_confidence_normalized");
		assert.equal(result.judge_resolution.value, "Sumudu Premachandra, J.");
	} finally {
		globalThis.fetch = originalFetch;
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	}
});

test("facet value discovery returns every targeted indexed judge label rather than a global top-facet sample", async () => {
	const originalFetch = globalThis.fetch;
	const previous = Object.fromEntries(["JUNIOR_TYPESENSE_ENABLED", "JUNIOR_TYPESENSE_DECISION_HOST", "JUNIOR_TYPESENSE_DECISION_API_KEY"].map((key) => [key, process.env[key]]));
	process.env.JUNIOR_TYPESENSE_ENABLED = "true";
	process.env.JUNIOR_TYPESENSE_DECISION_HOST = "decisions.example.test";
	process.env.JUNIOR_TYPESENSE_DECISION_API_KEY = "test-key";
	const requests = [];
	globalThis.fetch = async (input) => {
		const url = new URL(String(input));
		requests.push(url);
		return new Response(JSON.stringify({ facet_counts: [{ field_name: "judge_final", counts: [
			{ value: "Weeramantry, J.", count: 51 },
			{ value: "Christopher Weeramantry, J.", count: 14 },
		] }] }), { status: 200 });
	};
	try {
		const result = await retrieveLegalSourceDetails({ source: "case_decision", operation: "facet_values", facet_field: "judge_name", facet_query: "Weeramantry" });
		assert.equal(requests.length, 1);
		assert.equal(requests[0].searchParams.get("facet_by"), "judge_final");
		assert.equal(requests[0].searchParams.get("facet_query"), "judge_final:Weeramantry");
		assert.deepEqual(result.values, [{ value: "Weeramantry, J.", count: 51 }, { value: "Christopher Weeramantry, J.", count: 14 }]);
		assert.equal(result.possibly_truncated, false);
	} finally {
		globalThis.fetch = originalFetch;
		for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
});

test("case catalogue requires a selection for an incomplete judge name and accepts an explicit returned label set", async () => {
	const originalFetch = globalThis.fetch;
	const previous = Object.fromEntries(["JUNIOR_TYPESENSE_ENABLED", "JUNIOR_TYPESENSE_DECISION_HOST", "JUNIOR_TYPESENSE_DECISION_API_KEY"].map((key) => [key, process.env[key]]));
	process.env.JUNIOR_TYPESENSE_ENABLED = "true";
	process.env.JUNIOR_TYPESENSE_DECISION_HOST = "decisions.example.test";
	process.env.JUNIOR_TYPESENSE_DECISION_API_KEY = "test-key";
	const requests = [];
	globalThis.fetch = async (input) => {
		const url = new URL(String(input));
		requests.push(url);
		if (url.searchParams.get("facet_by") === "judge_final") return new Response(JSON.stringify({ facet_counts: [{ field_name: "judge_final", counts: [
			{ value: "Weeramantry, J.", count: 51 },
			{ value: "Christopher Weeramantry, J.", count: 14 },
		] }] }), { status: 200 });
		return new Response(JSON.stringify({ found: 65, hits: [] }), { status: 200 });
	};
	try {
		const ambiguous = await retrieveLegalSourceDetails({ source: "case_decision", operation: "case_catalog", judge_name: "Weeramantry" });
		assert.equal(ambiguous.judge_resolution.status, "needs_selection");
		assert.equal(ambiguous.judge_resolution.candidates.length, 2);

		const selected = await retrieveLegalSourceDetails({ source: "case_decision", operation: "case_catalog", judge_labels: ["Weeramantry, J.", "Christopher Weeramantry, J."] });
		assert.equal(selected.found, 65);
		assert.deepEqual(selected.applied_filters.judge_final, ["Weeramantry, J.", "Christopher Weeramantry, J."]);
		assert.match(requests.at(-1).searchParams.get("filter_by"), /judge_final:=\[`Weeramantry, J\.`, `Christopher Weeramantry, J\.`\]/);
	} finally {
		globalThis.fetch = originalFetch;
		for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
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

test("case catalogue resolves court, report, month and numeric report filters before searching", async () => {
	const originalFetch = globalThis.fetch;
	const previous = Object.fromEntries(["JUNIOR_TYPESENSE_ENABLED", "JUNIOR_TYPESENSE_DECISION_HOST", "JUNIOR_TYPESENSE_DECISION_API_KEY"].map((key) => [key, process.env[key]]));
	process.env.JUNIOR_TYPESENSE_ENABLED = "true";
	process.env.JUNIOR_TYPESENSE_DECISION_HOST = "decisions.example.test";
	process.env.JUNIOR_TYPESENSE_DECISION_API_KEY = "test-key";
	const requests = [];
	globalThis.fetch = async (input) => {
		const url = new URL(String(input));
		requests.push(url);
		const field = url.searchParams.get("facet_by");
		if (field) {
			const values = { sc_or_ca: "CA", report: "NLR", decision_month: "September" };
			return new Response(JSON.stringify({ facet_counts: [{ field_name: field, counts: [{ value: values[field], count: 3 }] }] }), { status: 200 });
		}
		return new Response(JSON.stringify({ found: 1, hits: [{ document: { primary_key: "case-2", standard_casenumber: "CA/NLR/1", nameofparties: "A v B", summary_text: "Tax", report: "NLR", sc_or_ca: "CA", decision_month: "September", decision_year: 2026, report_year: 2026, volume_num: 3, page_num: 99, link: "https://lex.example/case-2" } }] }), { status: 200 });
	};
	try {
		const result = await retrieveLegalSourceDetails({ source: "case_decision", operation: "case_catalog", court: "Court of Appeal", report: "NLR", decision_month: "September", decision_year: 2026, report_year: 2026, volume_num: 3, page_num: 99, subject_query: "tax" });
		assert.equal(result.found, 1);
		assert.equal(result.applied_filters.sc_or_ca, "CA");
		assert.equal(result.applied_filters.report, "NLR");
		assert.equal(result.applied_filters.decision_month, "September");
		assert.match(requests.at(-1).searchParams.get("filter_by"), /sc_or_ca:=`CA`/);
		assert.match(requests.at(-1).searchParams.get("filter_by"), /report:=`NLR`/);
		assert.match(requests.at(-1).searchParams.get("filter_by"), /decision_month:=`September`/);
		assert.match(requests.at(-1).searchParams.get("filter_by"), /report_year:=2026/);
	} finally {
		globalThis.fetch = originalFetch;
		for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
});

test("case catalogue requests confirmation for genuinely ambiguous judge matches", async () => {
	const originalFetch = globalThis.fetch;
	const previous = Object.fromEntries(["JUNIOR_TYPESENSE_ENABLED", "JUNIOR_TYPESENSE_DECISION_HOST", "JUNIOR_TYPESENSE_DECISION_API_KEY"].map((key) => [key, process.env[key]]));
	process.env.JUNIOR_TYPESENSE_ENABLED = "true";
	process.env.JUNIOR_TYPESENSE_DECISION_HOST = "decisions.example.test";
	process.env.JUNIOR_TYPESENSE_DECISION_API_KEY = "test-key";
	globalThis.fetch = async () => new Response(JSON.stringify({ facet_counts: [{ field_name: "judge_final", counts: [{ value: "A. Perera, J.", count: 2 }, { value: "B. Perera, J.", count: 2 }] }] }), { status: 200 });
	try {
		const result = await retrieveLegalSourceDetails({ source: "case_decision", operation: "case_catalog", judge_name: "Perera", decision_year: 2026 });
		assert.equal(result.found, 0);
		assert.equal(result.judge_resolution.status, "needs_confirmation");
		assert.equal(result.judge_resolution.candidates.length, 2);
	} finally {
		globalThis.fetch = originalFetch;
		for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
});

test("Lex amendment catalogue retains every matching structured amendment rather than a truncated summary", async () => {
	const originalFetch = globalThis.fetch;
	const oldUrl = process.env.JUNIOR_LEX_LEGISLATION_API_URL;
	const oldKey = process.env.JUNIOR_LEX_LEGISLATION_API_KEY;
	process.env.JUNIOR_LEX_LEGISLATION_API_URL = "https://lex.example.test";
	process.env.JUNIOR_LEX_LEGISLATION_API_KEY = "test-key";
	globalThis.fetch = async (input) => {
		const url = String(input);
		if (url.includes("/api/legislations?")) return new Response(JSON.stringify({ items: [{ id: "legislation_C_1", title: "Companies Act No. 7 of 2007", section_count: 500 }] }), { status: 200 });
		return new Response(JSON.stringify({ id: "legislation_C_1", title: "Companies Act No. 7 of 2007", amendments: [
			{ reference: "Companies (Amendment) Act No. 1 of 2025", enactment_date: "2025-01-10", url: "https://lex.example/amendment-1" },
			{ reference: "Companies (Amendment) Act No. 2 of 2025", date: "2025-06-11", url: "https://lex.example/amendment-2", affected_provisions: ["s. 12"] },
			{ reference: "Companies (Amendment) Act No. 1 of 2024", enactment_date: "2024-04-01", url: "https://lex.example/amendment-2024" },
		] }), { status: 200 });
	};
	try {
		const result = await retrieveLexLegislationDetails({ operation: "amendment_catalog", legislation_title: "Companies Act", amendment_year: 2025 });
		assert.equal(result.found, 2);
		assert.equal(result.amendments.length, 2);
		assert.deepEqual(result.amendments.map((item) => item.url), ["https://lex.example/amendment-1", "https://lex.example/amendment-2"]);
	} finally {
		globalThis.fetch = originalFetch;
		if (oldUrl === undefined) delete process.env.JUNIOR_LEX_LEGISLATION_API_URL; else process.env.JUNIOR_LEX_LEGISLATION_API_URL = oldUrl;
		if (oldKey === undefined) delete process.env.JUNIOR_LEX_LEGISLATION_API_KEY; else process.env.JUNIOR_LEX_LEGISLATION_API_KEY = oldKey;
	}
});

test("Lex recent amendment catalogue reads each bounded page and returns the newest instruments first", async () => {
	const originalFetch = globalThis.fetch;
	const oldUrl = process.env.JUNIOR_LEX_LEGISLATION_API_URL;
	const oldKey = process.env.JUNIOR_LEX_LEGISLATION_API_KEY;
	process.env.JUNIOR_LEX_LEGISLATION_API_URL = "https://lex.example.test";
	process.env.JUNIOR_LEX_LEGISLATION_API_KEY = "test-key";
	const requests = [];
	globalThis.fetch = async (input) => {
		const url = new URL(String(input));
		requests.push(url);
		const page = Number(url.searchParams.get("page"));
		const pages = {
			1: {
				total: 4, pages: 2, items: [
					{ id: "legislation_A_1", title: "Act A (Amendment) Act", enactment_year: 2024 },
					{ id: "legislation_C_1", title: "Constitutional Amendment", enactment_year: 2026 },
				],
			},
			2: {
				total: 4, pages: 2, items: [
					{ id: "legislation_O_1", title: "Other Amendment Act", enactment_year: 2025 },
					{ id: "legislation_N_1", title: "Not an amending law", enactment_year: 2026 },
				],
			},
		};
		return new Response(JSON.stringify(pages[page]), { status: 200 });
	};
	try {
		const result = await retrieveLexLegislationDetails({ operation: "recent_amendments", recent_limit: 2 });
		assert.equal(requests.length, 2);
		assert.equal(requests[0].searchParams.get("q"), "Amendment");
		assert.equal(requests[0].searchParams.get("per_page"), "100");
		assert.equal(result.found, 2);
		assert.deepEqual(result.records.map((item) => item.record_id), ["legislation_C_1", "legislation_O_1"]);
		assert.equal(result.records[0].fields.link, "https://lex.example.test/legislation_C_1/legislation/full-view");
		assert.deepEqual(result.catalogue_coverage, { matching_title_records: 4, pages_available: 2, pages_read: 2, complete: true });
	} finally {
		globalThis.fetch = originalFetch;
		if (oldUrl === undefined) delete process.env.JUNIOR_LEX_LEGISLATION_API_URL; else process.env.JUNIOR_LEX_LEGISLATION_API_URL = oldUrl;
		if (oldKey === undefined) delete process.env.JUNIOR_LEX_LEGISLATION_API_KEY; else process.env.JUNIOR_LEX_LEGISLATION_API_KEY = oldKey;
	}
});

test("case catalogue reports incomplete pagination rather than disguising a first page as a complete list", async () => {
	const originalFetch = globalThis.fetch;
	const previous = Object.fromEntries(["JUNIOR_TYPESENSE_ENABLED", "JUNIOR_TYPESENSE_DECISION_HOST", "JUNIOR_TYPESENSE_DECISION_API_KEY"].map((key) => [key, process.env[key]]));
	process.env.JUNIOR_TYPESENSE_ENABLED = "true";
	process.env.JUNIOR_TYPESENSE_DECISION_HOST = "decisions.example.test";
	process.env.JUNIOR_TYPESENSE_DECISION_API_KEY = "test-key";
	const requests = [];
	globalThis.fetch = async (input) => {
		const url = new URL(String(input));
		requests.push(url);
		if (!url.pathname.endsWith("/documents/search")) return new Response(JSON.stringify({ fields: [] }), { status: 200 });
		return new Response(JSON.stringify({
			found: 9,
			hits: Array.from({ length: 5 }, (_, index) => ({ document: {
				primary_key: `case-${index + 1}`,
				nameofparties: `Party ${index + 1} v Respondent`,
				decision_year: 2026,
				sc_or_ca: "SC",
				link: `https://lex.example/case-${index + 1}`,
			} })),
		}), { status: 200 });
	};
	try {
		const result = await retrieveLegalSourceDetails({ source: "case_decision", operation: "case_catalog", decision_year: 2026, page_size: 5 });
		assert.equal(requests.length, 1);
		assert.equal(requests[0].searchParams.get("per_page"), "5");
		assert.equal(result.found, 9);
		assert.equal(result.returned, 5);
		assert.equal(result.total_pages, 2);
		assert.equal(result.has_more, true);
		assert.equal(result.next_page, 2);
	} finally {
		globalThis.fetch = originalFetch;
		for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
});

test("case catalogue resolves a natural court name through an indexed court abbreviation", async () => {
	const originalFetch = globalThis.fetch;
	const previous = Object.fromEntries(["JUNIOR_TYPESENSE_ENABLED", "JUNIOR_TYPESENSE_DECISION_HOST", "JUNIOR_TYPESENSE_DECISION_API_KEY"].map((key) => [key, process.env[key]]));
	process.env.JUNIOR_TYPESENSE_ENABLED = "true";
	process.env.JUNIOR_TYPESENSE_DECISION_HOST = "decisions.example.test";
	process.env.JUNIOR_TYPESENSE_DECISION_API_KEY = "test-key";
	const requests = [];
	globalThis.fetch = async (input) => {
		const url = new URL(String(input));
		requests.push(url);
		if (url.searchParams.get("facet_by") === "sc_or_ca") {
			const query = url.searchParams.get("facet_query");
			const counts = query === "sc_or_ca:sc" ? [{ value: "SC", count: 9 }] : [];
			return new Response(JSON.stringify({ facet_counts: [{ field_name: "sc_or_ca", counts }] }), { status: 200 });
		}
		return new Response(JSON.stringify({ found: 9, hits: [] }), { status: 200 });
	};
	try {
		const result = await retrieveLegalSourceDetails({ source: "case_decision", operation: "case_catalog", court: "Supreme Court", decision_year: 2026, page_size: 20 });
		assert.equal(result.found, 9);
		assert.equal(result.applied_filters.sc_or_ca, "SC");
		assert.deepEqual(requests.slice(0, 2).map((url) => url.searchParams.get("facet_query")), ["sc_or_ca:Supreme Court", "sc_or_ca:sc"]);
		assert.match(requests.at(-1).searchParams.get("filter_by"), /sc_or_ca:=`SC`/);
	} finally {
		globalThis.fetch = originalFetch;
		for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
});
