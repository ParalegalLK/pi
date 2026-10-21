import { booleanEnv, env, requiredEnv } from "./environment.mjs";
import { lexLegislationCapabilities, retrieveLexLegislationDetails } from "./lex-legislation-sources.mjs";

const MAX_RESULTS = 8;
const MAX_CATALOG_RESULTS = 20;
const MAX_CATALOG_FIELD_CHARS = 2_400;
const DEFAULT_FIELD_CHARS = 12_000;
const MAX_FIELD_CHARS = 60_000;

const SOURCE_DEFINITIONS = {
	case_decision: {
		label: "full case decisions",
		prefix: "JUNIOR_TYPESENSE_DECISION",
		collectionFallback: "paralegal",
		defaultFields: ["primary_key", "standard_casenumber", "nameofparties", "summary_text", "link", "decision_year", "sc_or_ca"],
		fields: ["primary_key", "standard_casenumber", "nameofparties", "summary_text", "decision_text", "top_50_sentences_joined", "legislation", "keywords", "keywords_laws_provisions_terms_", "judge_final", "sc_or_ca", "action_type", "decision_year", "decision_month", "report", "report_year", "volume_num", "page_num", "date", "link", "s3_link", "download_url", "num_pages", "case_filed_year"],
		defaultQueryBy: "summary_text,standard_casenumber,nameofparties",
		catalogQueryBy: "decision_text,summary_text",
		catalogFields: ["primary_key", "standard_casenumber", "nameofparties", "summary_text", "keywords", "judge_final", "sc_or_ca", "action_type", "decision_year", "decision_month", "report", "report_year", "volume_num", "page_num", "date", "link", "s3_link", "download_url"],
		identifierField: "primary_key",
		filterFields: {
			judge_name: { field: "judge_final", kind: "facet", label: "judge" },
			court: { field: "sc_or_ca", kind: "facet", label: "court" },
			report: { field: "report", kind: "facet", label: "law report series" },
			action_type: { field: "action_type", kind: "facet", label: "action type" },
			decision_month: { field: "decision_month", kind: "facet", label: "decision month" },
			decision_year: { field: "decision_year", kind: "integer", label: "decision year" },
			report_year: { field: "report_year", kind: "integer", label: "report year" },
			volume_num: { field: "volume_num", kind: "integer", label: "report volume" },
			page_num: { field: "page_num", kind: "integer", label: "report page" },
		},
	},
	case_chunk: {
		label: "case-law passages",
		prefix: "JUNIOR_TYPESENSE_CHUNK",
		collectionFallback: "paralegal",
		defaultFields: ["primary_key", "standard_casenumber", "nameofparties", "chunk_text", "link", "decision_year", "sc_or_ca"],
		fields: ["id", "chunk_id", "primary_key", "standard_casenumber", "nameofparties", "chunk_text", "keywords", "judge_final", "sc_or_ca", "action_type", "decision_year", "decision_month", "report", "date", "link"],
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
		candidateFilterFields: ["book_slug", "book_title", "chapter_number", "chapter_title", "section_title"],
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

function boundedInteger(value, { minimum, maximum, fallback, name }) {
	if (value === undefined || value === null || value === "") return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
	return parsed;
}

function filterValue(value) {
	return String(value).replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/[\r\n]+/g, " ").trim();
}

function exactStringFilter(field, value) {
	const safe = filterValue(value);
	if (!safe) throw new Error(`${field} contains no usable characters.`);
	return `${field}:=\`${safe}\``;
}

function normalizedValue(value) {
	return String(value || "")
		.toLocaleLowerCase("en-US")
		.replace(/[’'.,()/\\_-]/g, " ")
		.replace(/\b(?:justice|judge|hon|the|mr|mrs|ms|dr|j|jsc|pc)\b/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function normalizedJudgeName(value) {
	return normalizedValue(value);
}

function words(value) {
	return normalizedValue(value).split(" ").filter((word) => word.length > 1);
}

function levenshtein(left, right) {
	if (left === right) return 0;
	if (!left) return right.length;
	if (!right) return left.length;
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let row = 1; row <= left.length; row += 1) {
		const current = [row];
		for (let column = 1; column <= right.length; column += 1) {
			current[column] = Math.min(current[column - 1] + 1, previous[column] + 1, previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1));
		}
		previous = current;
	}
	return previous[right.length];
}

function similarity(left, right) {
	const a = normalizedValue(left);
	const b = normalizedValue(right);
	if (!a || !b) return 0;
	if (a === b) return 1;
	const edit = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
	const aWords = words(a);
	const bWords = words(b);
	const common = aWords.filter((word) => bWords.includes(word)).length;
	const overlap = common / Math.max(aWords.length, bWords.length);
	const compatibleShortName = aWords.length >= 2 && bWords.length >= 2
		&& aWords[0] === bWords[0] && aWords.at(-1) === bWords.at(-1)
		&& (aWords.every((word) => bWords.includes(word)) || bWords.every((word) => aWords.includes(word)));
	return Math.max(edit, overlap, compatibleShortName ? 0.97 : 0);
}

function facetValues(payload, field) {
	const facets = Array.isArray(payload?.facet_counts) ? payload.facet_counts : [];
	const facet = facets.find((item) => item?.field_name === field);
	if (!facet || !Array.isArray(facet.counts)) return [];
	return facet.counts
		.filter((item) => typeof item?.value === "string" && item.value.trim())
		.map((item) => ({ value: item.value.trim(), count: Number(item.count || 0) }));
}

function canonicalRequestedValue(field, requested) {
	const value = normalizedValue(requested);
	if (field === "sc_or_ca") {
		if (["supreme court", "sc"].includes(value)) return "sc";
		if (["court of appeal", "appeal court", "ca"].includes(value)) return "ca";
		if (["privy council", "pc"].includes(value)) return "pc";
	}
	if (field === "decision_month") {
		const months = { january: "1", february: "2", march: "3", april: "4", may: "5", june: "6", july: "7", august: "8", september: "9", october: "10", november: "11", december: "12" };
		if (months[value]) return months[value];
	}
	return value;
}

function rankedCandidates(values, requested, field) {
	const canonical = canonicalRequestedValue(field, requested);
	return values
		.map((candidate) => ({ ...candidate, score: similarity(canonical, field === "sc_or_ca" ? canonicalRequestedValue(field, candidate.value) : candidate.value) }))
		.filter((candidate) => candidate.score >= 0.45)
		.sort((left, right) => right.score - left.score || right.count - left.count || left.value.localeCompare(right.value))
		.slice(0, 12);
}

function confidentResolution(field, requested, values) {
	const requestedNormalized = canonicalRequestedValue(field, requested);
	const candidates = rankedCandidates(values, requested, field);
	const exact = candidates.find((candidate) => canonicalRequestedValue(field, candidate.value) === requestedNormalized);
	if (exact) return { status: "resolved", requested, value: exact.value, matched_by: "normalized_exact", confidence: 1 };
	const selected = candidates[0];
	const runnerUp = candidates[1];
	const uniqueHighConfidence = selected && selected.score >= 0.88 && (!runnerUp || selected.score - runnerUp.score >= 0.08);
	if (uniqueHighConfidence) return { status: "resolved", requested, value: selected.value, matched_by: "high_confidence_normalized", confidence: Number(selected.score.toFixed(3)) };
	return { status: candidates.length ? "needs_confirmation" : "not_found", requested, candidates: candidates.map(({ score, ...candidate }) => ({ ...candidate, confidence: Number(score.toFixed(3)) })) };
}

function resolvedValue(resolutions, key) {
	return resolutions[key]?.status === "resolved" ? resolutions[key].value : undefined;
}

function catalogueFilter(args, resolutions = {}, { except } = {}) {
	const filters = [];
	for (const [key, descriptor] of Object.entries(SOURCE_DEFINITIONS.case_decision.filterFields)) {
		if (key === except) continue;
		if (descriptor.kind === "integer") {
			if (args[key] === undefined || args[key] === null || args[key] === "") continue;
			const maximum = key.includes("year") ? 2200 : 100_000;
			filters.push(`${descriptor.field}:=${boundedInteger(args[key], { minimum: key.includes("year") ? 1800 : 1, maximum, fallback: undefined, name: key })}`);
		} else {
			const value = resolvedValue(resolutions, key);
			if (value) filters.push(exactStringFilter(descriptor.field, value));
		}
	}
	return filters.join(" && ");
}

function catalogParameters(config, args, fields, resolutions) {
	const page = boundedInteger(args.page, { minimum: 1, maximum: 100, fallback: 1, name: "page" });
	const pageSize = boundedInteger(args.page_size, { minimum: 1, maximum: MAX_CATALOG_RESULTS, fallback: 10, name: "page_size" });
	const subject = String(args.subject_query || args.query || "").trim() || "*";
	const params = new URLSearchParams({
		q: subject,
		query_by: config.definition.catalogQueryBy,
		page: String(page),
		per_page: String(pageSize),
		include_fields: [...new Set([...fields, config.definition.identifierField])].join(","),
	});
	const filter = catalogueFilter(args, resolutions);
	if (filter) params.set("filter_by", filter);
	return { params, page, pageSize, subject, filter };
}

function facetParameters(config, args, facetKey, resolutions) {
	const descriptor = config.definition.filterFields[facetKey];
	const params = new URLSearchParams({
		q: "*",
		query_by: config.definition.catalogQueryBy,
		per_page: "1",
		include_fields: config.definition.identifierField,
		facet_by: descriptor.field,
		max_facet_values: "250",
	});
	const filter = catalogueFilter(args, resolutions, { except: facetKey });
	if (filter) params.set("filter_by", filter);
	return params;
}

async function resolveFacet(config, args, key, resolutions) {
	if (args[key] === undefined || args[key] === null || args[key] === "") return { status: "not_requested" };
	const descriptor = config.definition.filterFields[key];
	const payload = await fetchTypesense(config, facetParameters(config, args, key, resolutions));
	return confidentResolution(descriptor.field, args[key], facetValues(payload, descriptor.field));
}

async function resolveCatalogueFacets(config, args) {
	const resolutions = {};
	for (const key of ["court", "report", "action_type", "decision_month", "judge_name"]) {
		resolutions[key] = await resolveFacet(config, args, key, resolutions);
		if (resolutions[key].status !== "not_requested" && resolutions[key].status !== "resolved") return resolutions;
	}
	return resolutions;
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

async function fetchCollectionSchema(config) {
	const response = await fetch(endpoint(config, `/collections/${encodeURIComponent(config.collection)}`), {
		headers: { "X-TYPESENSE-API-KEY": config.apiKey },
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) return null;
	try { return await response.json(); } catch { return null; }
}

function normalizeRecord(document, fields, maximum) {
	const state = { truncated: false };
	const values = {};
	for (const field of fields) {
		if (document[field] !== undefined) values[field] = compactValue(document[field], maximum, state);
	}
	return { record_id: document.primary_key || document.id || document.chunk_id || null, fields: values, truncated: state.truncated };
}

async function retrieveCaseCatalogue(config, args, maximum, onProgress) {
	if (args.source !== "case_decision") throw new Error("case_catalog is supported only for full case decisions.");
	const hasCriterion = [args.subject_query, args.query, args.judge_name, args.decision_year, args.decision_month, args.court, args.report, args.report_year, args.volume_num, args.page_num, args.action_type]
		.some((value) => value !== undefined && value !== null && String(value).trim());
	if (!hasCriterion) throw new Error("case_catalog requires a subject query or at least one structured filter.");
	onProgress("Resolving requested case-catalogue filters against indexed values…");
	const resolutions = await resolveCatalogueFacets(config, args);
	// A catalogue answer must carry enough metadata to identify and link the
	// returned decision even when Pi asked for a narrower display field set.
	const fields = requestedFields(config.definition, [...config.definition.catalogFields, ...(args.fields || [])]);
	const unresolved = Object.values(resolutions).find((item) => item.status !== "not_requested" && item.status !== "resolved");
	if (unresolved) {
		return {
			source: args.source,
			source_label: config.definition.label,
			operation: "case_catalog",
			found: 0,
			page: 1,
			page_size: 0,
			has_more: false,
			filter_resolution: resolutions,
			judge_resolution: resolutions.judge_name,
			requested_fields: fields,
			available_fields: config.definition.fields,
			records: [],
			guidance: "A requested filter could not be confidently resolved. Ask the user to choose only if candidates were returned; otherwise say that the indexed catalogue has no matching value. Do not guess.",
		};
	}
	onProgress("Searching indexed case decisions with the requested subject and structured filters…");
	const catalogue = catalogParameters(config, args, fields, resolutions);
	const payload = await fetchTypesense(config, catalogue.params);
	const found = Number(payload.found || 0);
	return {
		source: args.source,
		source_label: config.definition.label,
		operation: "case_catalog",
		found,
		page: catalogue.page,
		page_size: catalogue.pageSize,
		has_more: catalogue.page * catalogue.pageSize < found,
		filter_resolution: resolutions,
		judge_resolution: resolutions.judge_name,
		applied_filters: {
			decision_year: args.decision_year === undefined || args.decision_year === null || args.decision_year === "" ? undefined : Number(args.decision_year),
			decision_month: resolvedValue(resolutions, "decision_month"),
			judge_final: resolvedValue(resolutions, "judge_name"),
			sc_or_ca: resolvedValue(resolutions, "court"),
			report: resolvedValue(resolutions, "report"),
			report_year: args.report_year === undefined || args.report_year === null || args.report_year === "" ? undefined : Number(args.report_year),
			volume_num: args.volume_num === undefined || args.volume_num === null || args.volume_num === "" ? undefined : Number(args.volume_num),
			page_num: args.page_num === undefined || args.page_num === null || args.page_num === "" ? undefined : Number(args.page_num),
			action_type: resolvedValue(resolutions, "action_type"),
			subject_query: catalogue.subject === "*" ? undefined : catalogue.subject,
		},
		requested_fields: fields,
		available_fields: config.definition.fields,
		records: (payload.hits || []).map((hit) => normalizeRecord(hit.document || {}, fields, Math.min(maximum, MAX_CATALOG_FIELD_CHARS))),
		guidance: "These are indexed case-catalogue matches, not a legal conclusion or a complete court registry. Preserve returned case links. Retrieve bounded decision detail for selected cases before describing a holding; use RAG Chat when the user asks for legal analysis or synthesis.",
	};
}

async function sourceCapabilities(config) {
	const definition = config.definition;
	if (definition === SOURCE_DEFINITIONS.case_decision) return {
		source: "case_decision",
		source_label: definition.label,
		operation: "capabilities",
		available_fields: definition.fields,
		supported_filters: Object.fromEntries(Object.entries(definition.filterFields).map(([name, item]) => [name, { label: item.label, type: item.kind === "integer" ? "integer" : "canonical indexed value" }])),
		guidance: "Use only documented parameters. Canonical names for judge, court, report, action type and month are resolved internally from bounded index facets; do not compose raw filters.",
	};
	if (definition === SOURCE_DEFINITIONS.book) {
		const schema = await fetchCollectionSchema(config);
		const facetNames = new Set((schema?.fields || []).filter((field) => field?.facet).map((field) => field.name));
		const supported = definition.candidateFilterFields.filter((field) => facetNames.has(field));
		return {
			source: "book",
			source_label: definition.label,
			operation: "capabilities",
			available_fields: definition.fields,
			supported_filters: supported,
			guidance: supported.length ? "Only these verified book fields may be used as structured filters." : "No book facets were verified. Use text/headings retrieval rather than assuming a filter is supported.",
		};
	}
	return { source: "case_chunk", source_label: definition.label, operation: "capabilities", available_fields: definition.fields, supported_filters: [], guidance: "Use bounded text retrieval for this source." };
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
	if (source === "legislation") {
		if (args.operation === "capabilities") return lexLegislationCapabilities();
		return retrieveLexLegislationDetails(args, { onProgress });
	}
	const config = sourceConfig(source);
	const configuredLimit = Number(env("JUNIOR_TYPESENSE_MAX_FIELD_CHARS", String(DEFAULT_FIELD_CHARS)));
	const maximum = Math.min(Math.max(Number(args.max_field_characters || configuredLimit), 1_000), MAX_FIELD_CHARS);
	if (args.operation === "capabilities") return sourceCapabilities(config);
	if (args.operation === "case_catalog") return retrieveCaseCatalogue(config, { ...args, source }, maximum, onProgress);
	const fields = requestedFields(config.definition, args.fields);
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
