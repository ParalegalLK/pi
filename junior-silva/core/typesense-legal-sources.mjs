import { booleanEnv, env, requiredEnv } from "./environment.mjs";
import { retrieveLexLegislationDetails } from "./lex-legislation-sources.mjs";

const MAX_RESULTS = 8;
const DEFAULT_FIELD_CHARS = 12_000;
const MAX_FIELD_CHARS = 60_000;

const SOURCE_DEFINITIONS = {
	case_decision: {
		label: "full case decisions",
		prefix: "JUNIOR_TYPESENSE_DECISION",
		collectionFallback: "paralegal",
		defaultFields: ["primary_key", "standard_casenumber", "nameofparties", "summary_text", "link", "decision_year", "sc_or_ca"],
		fields: ["primary_key", "standard_casenumber", "nameofparties", "summary_text", "decision_text", "top_50_sentences_joined", "legislation", "keywords", "keywords_laws_provisions_terms_", "judge_final", "sc_or_ca", "action_type", "decision_year", "decision_month", "date", "link", "s3_link", "download_url", "num_pages", "case_filed_year"],
		defaultQueryBy: "summary_text,standard_casenumber,nameofparties",
		identifierField: "primary_key",
	},
	case_chunk: {
		label: "case-law passages",
		prefix: "JUNIOR_TYPESENSE_CHUNK",
		collectionFallback: "paralegal",
		defaultFields: ["primary_key", "standard_casenumber", "nameofparties", "chunk_text", "link", "decision_year", "sc_or_ca"],
		fields: ["id", "chunk_id", "primary_key", "standard_casenumber", "nameofparties", "chunk_text", "keywords", "judge_final", "sc_or_ca", "action_type", "decision_year", "decision_month", "date", "link"],
		defaultQueryBy: "chunk_text,standard_casenumber,nameofparties",
		identifierField: "id",
	},
	book: {
		label: "law-book commentary passages",
		prefix: "JUNIOR_TYPESENSE_BOOKS",
		collectionFallback: "law_book_chunks",
		defaultFields: ["id", "book_title", "chapter_number", "chapter_title", "section_title", "text", "book_slug", "chapter_id"],
		fields: ["id", "book_slug", "book_title", "chapter_id", "chapter_number", "chapter_title", "section_title", "headings", "text"],
		defaultQueryBy: "text,headings",
		identifierField: "id",
	},
	legislation: {
		label: "legislation and constitutional sections",
		prefix: "JUNIOR_TYPESENSE_LEGISLATION",
		collectionFallback: "paralegal_legislation",
		defaultFields: ["legislation_title", "section_number", "section_title", "section_content", "enactment_date", "part_number", "part_title"],
		fields: ["id", "legislation_title", "section_number", "section_title", "section_content", "section_subsections", "section_continuation", "enactment_date", "part_number", "part_title", "full_section_text"],
		defaultQueryBy: "legislation_title,full_section_text",
		identifierField: "id",
	},
};

function sourceConfig(source) {
	const definition = SOURCE_DEFINITIONS[source];
	if (!definition) throw new Error(`Unsupported legal source: ${source}`);
	const prefix = definition.prefix;
	const host = requiredEnv(`${prefix}_HOST`);
	const protocol = env(`${prefix}_PROTOCOL`, "https");
	const port = env(`${prefix}_PORT`, protocol === "https" ? "443" : "80");
	const path = env(`${prefix}_PATH`).replace(/^\/+|\/+$/g, "");
	const collection = env(`${prefix}_COLLECTION`, definition.collectionFallback);
	return { definition, host, protocol, port, path, collection, apiKey: requiredEnv(`${prefix}_API_KEY`) };
}

function endpoint(config, suffix) {
	const prefix = config.path ? `/${config.path}` : "";
	return `${config.protocol}://${config.host}:${config.port}${prefix}${suffix}`;
}

function compactValue(value, maximum, state) {
	if (typeof value === "string") {
		if (value.length <= maximum) return value;
		state.truncated = true;
		return `${value.slice(0, maximum)}\n\n[Source field truncated; request a narrower follow-up or a larger bounded limit.]`;
	}
	if (Array.isArray(value)) return value.map((item) => compactValue(item, maximum, state));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compactValue(item, maximum, state)]));
	}
	return value;
}

function requestedFields(definition, fields) {
	if (!fields?.length) return definition.defaultFields;
	const allowed = [...new Set(fields.filter((field) => definition.fields.includes(field)))];
	if (!allowed.length) throw new Error(`No requested fields are supported for this source. Available fields: ${definition.fields.join(", ")}.`);
	return allowed;
}

function searchParameters(config, args, fields) {
	const definition = config.definition;
	const operation = args.operation || "find";
	const requested = String(args.query || args.case_number || args.party_name || args.legislation_title || args.record_id || "").trim();
	if (!requested) throw new Error("Provide query, case_number, party_name, legislation_title, or record_id.");
	let queryBy = definition.defaultQueryBy;
	if (args.record_id) queryBy = definition.identifierField;
	else if (args.case_number) queryBy = "standard_casenumber";
	else if (args.party_name) queryBy = "nameofparties";
	else if (args.legislation_title) queryBy = "legislation_title";
	const params = new URLSearchParams({
		q: requested,
		query_by: queryBy,
		per_page: String(Math.min(Math.max(Number(args.max_results || (operation === "retrieve" ? 1 : 5)), 1), MAX_RESULTS)),
		// Always retrieve the source's stable identifier even when Pi did not ask
		// to display it: a later bounded `retrieve` call needs that handle.
		include_fields: [...new Set([...fields, definition.identifierField])].join(","),
	});
	if (args.section_number) {
		if (args.source !== "legislation") throw new Error("section_number is supported only for legislation.");
		const section = String(args.section_number).replace(/[^a-zA-Z0-9-]/g, "");
		if (!section) throw new Error("section_number contains no usable characters.");
		params.set("filter_by", `section_number:='${section}'`);
	}
	return params;
}

async function fetchTypesense(config, params) {
	const response = await fetch(endpoint(config, `/collections/${encodeURIComponent(config.collection)}/documents/search?${params}`), {
		headers: { "X-TYPESENSE-API-KEY": config.apiKey },
		signal: AbortSignal.timeout(30_000),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`Direct legal-source retrieval failed (${response.status}). Check configured source access.`);
	try { return JSON.parse(text); } catch { throw new Error("Direct legal-source retrieval returned invalid JSON."); }
}

function normalizeRecord(document, fields, maximum) {
	const state = { truncated: false };
	const values = {};
	for (const field of fields) {
		if (document[field] !== undefined) values[field] = compactValue(document[field], maximum, state);
	}
	return { record_id: document.primary_key || document.id || document.chunk_id || null, fields: values, truncated: state.truncated };
}

/**
 * Bounded direct Typesense retrieval for detail behind RAG-cited authorities.
 * It deliberately does not expose raw Typesense filters, arbitrary collections, or keys.
 */
export async function retrieveLegalSourceDetails(args, { onProgress = () => {} } = {}) {
	if (!booleanEnv("JUNIOR_TYPESENSE_ENABLED")) throw new Error("Direct legal-source retrieval is disabled by the administrator.");
	const source = String(args.source || "");
	// RAG itself uses Lex/SQLite first for Acts and amendments. Its Typesense
	// fallback is not a reliable legislation source, so preserve the one Pi-facing
	// tool while routing this source to the structured authority service.
	if (source === "legislation") return retrieveLexLegislationDetails(args, { onProgress });
	const config = sourceConfig(source);
	const fields = requestedFields(config.definition, args.fields);
	const configuredLimit = Number(env("JUNIOR_TYPESENSE_MAX_FIELD_CHARS", String(DEFAULT_FIELD_CHARS)));
	const maximum = Math.min(Math.max(Number(args.max_field_characters || configuredLimit), 1_000), MAX_FIELD_CHARS);
	onProgress(`Retrieving bounded detail from ${config.definition.label}…`);
	const payload = await fetchTypesense(config, searchParameters(config, { ...args, source }, fields));
	const records = (payload.hits || []).map((hit) => normalizeRecord(hit.document || {}, fields, maximum));
	return {
		source,
		source_label: config.definition.label,
		operation: args.operation || "find",
		found: Number(payload.found || 0),
		requested_fields: fields,
		available_fields: config.definition.fields,
		records,
		guidance: "This is retrieved source material, not a legal conclusion. Use it only to deepen a point already relevant to the user’s request; preserve any returned official/PDF link and do not claim an unavailable amendment history.",
	};
}

export const legalSourceDefinitions = SOURCE_DEFINITIONS;
