import { booleanEnv, env, requiredEnv } from "./environment.mjs";

const MAX_RESULTS = 8;
const DEFAULT_FIELD_CHARS = 12_000;
const MAX_FIELD_CHARS = 60_000;
const MAX_ARRAY_ITEMS = 12;

const LEGISLATION_FIELDS = [
	"id", "legislation_id", "title", "legislation_title", "description", "act_year", "enactment_date", "section_count",
	"section_number", "section_title", "content", "section_content", "subsections", "section_subsections", "continuation", "section_continuation",
	"part", "part_number", "part_title", "amendments", "snippet", "sections", "preamble", "pdf_urls", "textual_containers", "repealed_ranges", "repealed_by", "numbers", "schedules",
];

function cap(value, maximum, state) {
	if (typeof value === "string") {
		if (value.length <= maximum) return value;
		state.truncated = true;
		return `${value.slice(0, maximum)}\n\n[Source field truncated; request a narrower record or a larger bounded limit.]`;
	}
	if (Array.isArray(value)) {
		if (value.length > MAX_ARRAY_ITEMS) state.truncated = true;
		return value.slice(0, MAX_ARRAY_ITEMS).map((item) => cap(item, maximum, state));
	}
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cap(item, maximum, state)]));
	return value;
}

function selectedFields(fields) {
	if (!fields?.length) return LEGISLATION_FIELDS;
	const selected = [...new Set(fields.filter((field) => LEGISLATION_FIELDS.includes(field)))];
	if (!selected.length) throw new Error(`No requested legislation fields are supported. Available fields: ${LEGISLATION_FIELDS.join(", ")}.`);
	return selected;
}

function collectAmendments(value, collected = []) {
	if (Array.isArray(value)) {
		for (const item of value) collectAmendments(item, collected);
		return collected;
	}
	if (!value || typeof value !== "object") return collected;
	for (const amendment of Array.isArray(value.amendments) ? value.amendments : []) {
		const reference = amendment?.ref || amendment?.reference || amendment?.title;
		const url = amendment?.url || null;
		if (reference || url) collected.push({ reference: reference || null, url: url || null });
	}
	for (const item of Object.values(value)) collectAmendments(item, collected);
	return collected;
}

function normaliseTitle(value) {
	return String(value || "").toLocaleLowerCase("en-US").replace(/[’'.,()/_-]/g, " ").replace(/\s+/g, " ").trim();
}

function titleScore(query, candidate) {
	const wanted = normaliseTitle(query);
	const value = normaliseTitle(candidate);
	if (!wanted || !value) return 0;
	if (wanted === value) return 1;
	const wantedWords = wanted.split(" ");
	const valueWords = value.split(" ");
	const common = wantedWords.filter((word) => valueWords.includes(word)).length;
	if (wantedWords.every((word) => valueWords.includes(word))) return 0.98;
	return common / Math.max(wantedWords.length, valueWords.length);
}

function amendmentEntry(value, context = {}) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const reference = value.ref || value.reference || value.title || value.name || value.act || null;
	const url = value.url || value.link || value.href || null;
	const date = value.enactment_date || value.date || value.certified_date || value.effective_date || value.commencement_date || null;
	const yearMatch = String(date || reference || "").match(/\b(18\d{2}|19\d{2}|20\d{2}|21\d{2})\b/);
	if (!reference && !url && !date) return null;
	return {
		reference: reference ? String(reference) : null,
		url: typeof url === "string" ? url : null,
		date: date ? String(date) : null,
		year: yearMatch ? Number(yearMatch[1]) : null,
		affected_provisions: value.affected_provisions || value.provisions || value.sections || value.section_numbers || (context.section_number ? [context.section_number] : undefined),
	};
}

function collectFullAmendments(value, collected = [], context = {}) {
	if (Array.isArray(value)) {
		for (const item of value) collectFullAmendments(item, collected, context);
		return collected;
	}
	if (!value || typeof value !== "object") return collected;
	const nextContext = {
		section_number: value.section_number || context.section_number,
		section_title: value.section_title || context.section_title,
	};
	if (Array.isArray(value.amendments)) {
		for (const amendment of value.amendments) {
			const entry = amendmentEntry(amendment, nextContext);
			if (entry) collected.push(entry);
			collectFullAmendments(amendment, collected, nextContext);
		}
	}
	for (const [key, item] of Object.entries(value)) if (key !== "amendments") collectFullAmendments(item, collected, nextContext);
	return collected;
}

function distinctAmendments(entries) {
	const distinct = new Map();
	for (const entry of entries) {
		const key = JSON.stringify([entry.reference, entry.url, entry.date, entry.year]);
		const existing = distinct.get(key);
		if (!existing) { distinct.set(key, { ...entry }); continue; }
		const asList = (value) => Array.isArray(value) ? value : value ? [value] : [];
		const affected = [...new Set([...asList(existing.affected_provisions), ...asList(entry.affected_provisions)])];
		if (affected.length) existing.affected_provisions = affected;
	}
	return [...distinct.values()];
}

function pick(record, fields, maximum) {
	const state = { truncated: false };
	const values = {};
	for (const field of fields) if (record?.[field] !== undefined) values[field] = cap(record[field], maximum, state);
	const recordId = record?.id || record?.legislation_id || null;
	const amendments = collectAmendments(record);
	return { record_id: recordId, fields: values, amendments: amendments.length ? amendments : undefined, truncated: state.truncated };
}

function endpoint(pathname, query = {}) {
	const base = requiredEnv("JUNIOR_LEX_LEGISLATION_API_URL").replace(/\/$/, "");
	const url = new URL(`${base}${pathname}`);
	for (const [name, value] of Object.entries(query)) if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
	return url;
}

async function get(pathname, query) {
	const response = await fetch(endpoint(pathname, query), {
		// The Lex service reserves bearer authentication for interactive user JWTs.
		// Its documented service-to-service route is X-API-Key; using Bearer made
		// title searches appear to work while full Act and section reads failed.
		headers: { "X-API-Key": requiredEnv("JUNIOR_LEX_LEGISLATION_API_KEY") },
		signal: AbortSignal.timeout(30_000),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`Structured legislation retrieval failed (${response.status}). Check configured Lex API access.`);
	try { return JSON.parse(text); } catch { throw new Error("Structured legislation retrieval returned invalid JSON."); }
}

function isSectionId(value) {
	return /^\d+$/.test(String(value || "").trim());
}

function resolveSection(legislation, sectionNumber) {
	const wanted = String(sectionNumber).trim();
	const section = (legislation?.sections || []).find((item) => String(item?.section_number ?? item?.number ?? "").trim() === wanted);
	if (!section) throw new Error(`Section ${wanted} was not found in the selected legislation record.`);
	// Lex correctly stores some provisions wholly in structured subsections and
	// leaves section_content empty. Expose a readable complete provision while
	// retaining the original subsection objects for callers that need structure.
	const subsectionText = Array.isArray(section.subsections)
		? section.subsections
			.map((item) => [item?.id, item?.content].filter(Boolean).join(" ").trim())
			.filter(Boolean)
			.join("\n\n")
		: "";
	return {
		...section,
		section_content: String(section.section_content || "").trim() || subsectionText,
		legislation_id: legislation.id || legislation.legislation_id,
		legislation_title: legislation.title || legislation.legislation_title,
	};
}

/** Uses the same structured Lex/SQLite API RAG prefers for Sri Lankan Acts and amendments. */
export async function retrieveLexLegislationDetails(args, { onProgress = () => {} } = {}) {
	if (!booleanEnv("JUNIOR_LEX_LEGISLATION_ENABLED", true)) throw new Error("Structured legislation retrieval is disabled by the administrator.");
	const operation = args.operation || "find";
	const scope = args.legislation_scope || "legislation";
	const fields = selectedFields(args.fields);
	const configuredLimit = Number(env("JUNIOR_LEX_LEGISLATION_MAX_FIELD_CHARS", String(DEFAULT_FIELD_CHARS)));
	const maximum = Math.min(Math.max(Number(args.max_field_characters || configuredLimit), 1_000), MAX_FIELD_CHARS);
	const maxResults = Math.min(Math.max(Number(args.max_results || 5), 1), MAX_RESULTS);
	onProgress("Retrieving structured Sri Lankan legislation detail…");

	if (operation === "amendment_catalog") {
		const title = String(args.legislation_title || args.query || "").trim();
		const amendmentYear = boundedYear(args.amendment_year);
		if (!title) throw new Error("legislation_title is required to list an Act's amendments.");
		if (!amendmentYear) throw new Error("amendment_year is required to list amendments made in a particular year.");
		onProgress("Resolving the Act title and reading its complete structured amendment record…");
		const found = await get("/api/legislations", { q: title, per_page: 25 });
		const candidates = (found.items || [])
			.map((item) => ({ item, score: titleScore(title, item?.title || item?.legislation_title) }))
			.sort((left, right) => right.score - left.score || Number(right.item?.section_count || 0) - Number(left.item?.section_count || 0));
		const selected = candidates[0]?.item;
		if (!selected || candidates[0].score < 0.5) return {
			source: "legislation", source_label: "structured Lex legislation records", operation,
			found: 0, amendment_year: amendmentYear, amendments: [], records: [],
			guidance: "Lex did not confidently resolve the requested Act title. Ask for the Act's exact title or number rather than guessing.",
		};
		const recordId = selected.id || selected.legislation_id;
		const legislation = await get(`/api/legislations/${encodeURIComponent(recordId)}`);
		const amendments = distinctAmendments(collectFullAmendments(legislation)).filter((entry) => entry.year === amendmentYear);
		return {
			source: "legislation",
			source_label: "structured Lex legislation records",
			operation,
			found: amendments.length,
			amendment_year: amendmentYear,
			legislation: {
				record_id: recordId,
				title: legislation?.title || legislation?.legislation_title || selected.title || selected.legislation_title,
				enactment_date: legislation?.enactment_date || selected.enactment_date,
			},
			amendments,
			records: [],
			guidance: amendments.length
				? "These are every structured amendment entry in Lex for the resolved Act that matched the requested year. Preserve each returned link and distinguish an enactment date from a commencement date when both are present."
				: "Lex returned no structured amendment entry for that Act and year. Do not infer that no amendment exists outside the indexed Lex record; say the indexed record has no matching entry.",
		};
	}

	if (operation === "find") {
		const query = String(args.query || args.legislation_title || "").trim();
		if (!query) throw new Error("Provide query or legislation_title to find legislation.");
		let payload;
		if (scope === "section") {
			try {
				payload = await get("/api/search", { q: query, per_page: maxResults });
			} catch (error) {
				if (!String(error.message).includes("(401)")) throw error;
				// A title result is still useful when a deployment restricts semantic
				// section search. Pi can retrieve that Act with section_number next.
				payload = await get("/api/legislations", { q: query, per_page: maxResults });
			}
		} else payload = await get("/api/legislations", { q: query, per_page: maxResults });
		const records = (payload.items || []).map((item) => pick(item, fields, maximum));
		return {
			source: "legislation",
			source_label: "structured Lex legislation records",
			operation,
			scope,
			found: records.length,
			requested_fields: fields,
			available_fields: LEGISLATION_FIELDS,
			records,
			guidance: "This is structured Lex legislation source material. Retrieve an Act ID for all original sections, or pass that Act ID with section_number for one exact section. Amendment links are included only when Lex returned them.",
		};
	}

	const recordId = String(args.record_id || "").trim();
	if (!recordId) throw new Error("record_id from a prior legislation search is required for retrieve.");
	let payload;
	if (scope === "metadata") payload = await get(`/api/legislations/${encodeURIComponent(recordId)}/metadata`);
	else if (scope === "section" && isSectionId(recordId) && !args.section_number) payload = await get(`/api/sections/${encodeURIComponent(recordId)}`);
	else {
		// `legislation_*` is an Act identifier, not a numeric section-row ID.
		// Resolve requested section numbers from the Act's own ordered sections,
		// exactly as RAG Chat's SQLite legislation adapter does.
		const legislation = await get(`/api/legislations/${encodeURIComponent(recordId)}`);
		payload = args.section_number ? resolveSection(legislation, args.section_number) : legislation;
	}
	return {
		source: "legislation",
		source_label: "structured Lex legislation records",
		operation,
		scope,
		found: payload ? 1 : 0,
		requested_fields: fields,
		available_fields: LEGISLATION_FIELDS,
		records: payload ? [pick(payload, fields, maximum)] : [],
		guidance: "This is structured Lex legislation material. An Act ID plus section_number resolves the exact original section; a numeric section record ID may be read directly. Preserve returned official links and amendment references; do not invent amendment history or amendment URLs.",
	};
}

export const lexLegislationFields = LEGISLATION_FIELDS;

function boundedYear(value) {
	if (value === undefined || value === null || value === "") return undefined;
	const number = Number(value);
	if (!Number.isInteger(number) || number < 1800 || number > 2200) throw new Error("amendment_year must be an integer from 1800 to 2200.");
	return number;
}

export function lexLegislationCapabilities() {
	return {
		source: "legislation",
		source_label: "structured Lex legislation records",
		operation: "capabilities",
		available_fields: LEGISLATION_FIELDS,
		supported_filters: {
			legislation_title: { label: "Act title", type: "resolved structured title" },
			section_number: { label: "section number", type: "exact value after Act selection" },
			amendment_year: { label: "amendment year", type: "integer; used with amendment_catalog" },
		},
		guidance: "Lex supports title discovery and exact Act/section reads. amendment_catalog reads the complete selected Act record and locally filters its structured amendment entries by year; it does not use the unreliable legislation Typesense fallback.",
	};
}
