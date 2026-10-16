import path from "node:path";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { env } from "./environment.mjs";

const MAX_EXCERPT_CHARS = 18_000;

function parseMetadata(text, filename) {
	const head = String(text || "").match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
	const frontmatter = head?.[1] || "";
	const field = (name) => new RegExp("^" + name + ":\\s*(.*?)\\s*$", "m").exec(frontmatter)?.[1]?.replace(/^["']|["']$/g, "") || "";
	const list = (name) => (new RegExp("^" + name + ":\\s*\\[(.*?)\\]\\s*$", "m").exec(frontmatter)?.[1] || "").split(",").map((item) => item.trim()).filter(Boolean);
	return {
		document_type: field("document_type"),
		forum: field("forum"),
		year: field("year"),
		subject_matter: list("subject_matter"),
		key_clauses: list("key_clauses"),
		word_count: Number(field("word_count") || 0),
		body: String(text || "").slice(head?.[0]?.length || 0),
		filename,
	};
}

function relevance(record, query) {
	const terms = String(query || "").toLowerCase().split(/[^a-z0-9]+/).filter((item) => item.length > 2);
	const haystack = [record.document_type, record.forum, ...record.subject_matter, ...record.key_clauses, record.body.slice(0, 12000)].join(" ").toLowerCase();
	return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

async function markdownFiles(root, output = []) {
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const candidate = path.join(root, entry.name);
		if (entry.isDirectory()) await markdownFiles(candidate, output);
		else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) output.push(candidate);
	}
	return output;
}

async function knowledgeBaseRoot() {
	const configured = env("JUNIOR_SILVA_KB_ROOT");
	if (!configured) throw new Error("JUNIOR_SILVA_KB_ROOT is not configured. Native precedent retrieval is unavailable.");
	const root = await realpath(configured);
	if (!(await stat(root)).isDirectory()) throw new Error("JUNIOR_SILVA_KB_ROOT must be a readable directory.");
	return root;
}

export async function searchPrecedents(args, { onProgress = () => {} } = {}) {
	const query = String(args.query || "").trim();
	if (!query) throw new Error("query is required");
	onProgress("Searching the private drafting-precedent knowledge base…");
	const root = await knowledgeBaseRoot();
	const matches = [];
	for (const filename of await markdownFiles(root)) {
		const record = parseMetadata(await readFile(filename, "utf8"), path.relative(root, filename));
		if (args.document_type && record.document_type !== args.document_type) continue;
		const score = relevance(record, query);
		if (score) matches.push({ id: record.filename, document_type: record.document_type, forum: record.forum, year: record.year, subject_matter: record.subject_matter, key_clauses: record.key_clauses, word_count: record.word_count, relevance: score });
	}
	matches.sort((left, right) => right.relevance - left.relevance || left.id.localeCompare(right.id));
	return {
		query,
		results: matches.slice(0, Math.min(Number(args.max_results || 5), 10)),
		instruction: "These are private drafting precedents, not legal authority. Use them for structure and style only; use Sri Lankan RAG research for legal propositions and never disclose source paths or unrelated precedent content to the user.",
	};
}

export async function readPrecedent(args, { onProgress = () => {} } = {}) {
	onProgress("Reading the selected drafting precedent excerpt…");
	const root = await knowledgeBaseRoot();
	const filename = path.resolve(root, String(args.precedent_id || ""));
	if (!filename.startsWith(root + path.sep) || path.extname(filename).toLowerCase() !== ".md") throw new Error("The requested precedent is outside the configured knowledge base.");
	const record = parseMetadata(await readFile(filename, "utf8"), path.relative(root, filename));
	return {
		precedent_id: record.filename,
		metadata: { document_type: record.document_type, forum: record.forum, year: record.year, subject_matter: record.subject_matter, key_clauses: record.key_clauses },
		excerpt: record.body.slice(0, MAX_EXCERPT_CHARS),
		truncated: record.body.length > MAX_EXCERPT_CHARS,
		instruction: "Use this private precedent only as a drafting-pattern reference. Do not copy source-specific parties, values, facts, foreign-law provisions, or personal data into the final work product.",
	};
}

export async function validateDraft(args, { onProgress = () => {} } = {}) {
	if (!args.file_path) throw new Error("file_path is required");
	onProgress("Checking the native draft for unresolved placeholders and drafting hygiene…");
	const text = await readFile(args.file_path, "utf8");
	if (!text.trim()) throw new Error("The supplied draft file is empty. Write the completed draft to the configured workspace before validating or rendering it.");
	const flags = [];
	for (const marker of ["[FILL]", "[ASSUMED]", "[TODO]", "TBD", "TO BE CONFIRMED"]) {
		const count = text.split(marker).length - 1;
		if (count) flags.push({ type: "placeholder", marker, count });
	}
	const headings = [...text.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((match) => ({ level: match[1].length, text: match[2].trim() }));
	return {
		file_path: path.resolve(args.file_path),
		flags,
		headings,
		looks_like_markdown: /(^|\n)#{1,6}\s+/.test(text),
		instruction: "Resolve or clearly disclose every remaining assumption and placeholder before final delivery. Validate legal propositions with RAG; a precedent excerpt is not legal authority.",
	};
}
