import path from "node:path";
import { readFile } from "node:fs/promises";
import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import mammoth from "mammoth";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

const MAX_PREVIEW_CHARS = 180_000;
const MAX_DOCX_BYTES = 40 * 1024 * 1024;
const MAX_XML_CHARS = 12 * 1024 * 1024;
const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function escapeHtml(value) {
	return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}
function escapeAttribute(value) { return escapeHtml(value).replace(/[\r\n]/g, " "); }
function slug(value) { return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 70) || "legal-document"; }
function displayTitle(filename) { return path.basename(filename, path.extname(filename)).replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }

function safeHref(value) {
	try {
		const url = new URL(value, "https://preview.invalid");
		return url.protocol === "http:" || url.protocol === "https:" || (url.protocol === "https:" && url.hostname === "preview.invalid") ? value : "";
	} catch { return ""; }
}

// Mammoth is supplied with DOCX content that may contain arbitrary text. Preserve
// only a deliberately small HTML vocabulary and safe external/citation links.
function sanitizeDocumentHtml(value) {
	const allowed = new Set(["h1", "h2", "h3", "h4", "h5", "p", "br", "hr", "strong", "b", "em", "i", "u", "s", "small", "sup", "blockquote", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "a", "span", "div"]);
	return String(value)
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|iframe|object|embed|form|input|svg|math)\b[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/<(\/)?([A-Za-z0-9]+)([^>]*)>/g, (whole, closing, rawTag, rawAttributes) => {
			const tag = rawTag.toLowerCase();
			if (!allowed.has(tag)) return "";
			if (closing) return `</${tag}>`;
			if (tag === "br" || tag === "hr") return `<${tag}>`;
			let attributes = "";
			if (tag === "a") {
				const href = /\bhref\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s>]+))/i.exec(rawAttributes)?.slice(1).find(Boolean) || "";
				const safe = safeHref(href);
				if (safe) attributes = ` href=\"${escapeAttribute(safe)}\"`;
			}
			if (tag === "td" || tag === "th") {
				for (const name of ["colspan", "rowspan"]) {
					const value = new RegExp(`\\b${name}\\s*=\\s*[\"']?(\\d{1,3})`, "i").exec(rawAttributes)?.[1];
					if (value) attributes += ` ${name}=\"${value}\"`;
				}
			}
			return `<${tag}${attributes}>`;
		});
}

function documentHtml(title, body, note) {
	const clipped = body.length > MAX_PREVIEW_CHARS;
	const visible = clipped ? `${body.slice(0, MAX_PREVIEW_CHARS)}<p><strong>This browser preview is truncated for performance. Use the downloadable original for the complete document.</strong></p>` : body;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeAttribute(title)}</title><style>
body{margin:0;background:#eef1f5;color:#172033;font-family:Georgia,"Times New Roman",serif;line-height:1.55}main{box-sizing:border-box;max-width:920px;margin:28px auto;padding:64px 72px;background:#fff;box-shadow:0 8px 28px rgba(15,23,42,.12)}h1,h2,h3,h4{color:#111827;line-height:1.22}h1{font-size:2rem;text-align:center;margin-bottom:2rem}h2{font-size:1.35rem;border-bottom:1px solid #d1d5db;padding-bottom:.35rem}table{width:100%;border-collapse:collapse;margin:1rem 0}th,td{border:1px solid #9ca3af;padding:.5rem;vertical-align:top}blockquote{border-left:4px solid #64748b;margin-left:0;padding-left:1rem;color:#475569}.notice,.review-dashboard,.inline-review-note{font-family:system-ui,sans-serif}.notice{font-size:.86rem;color:#475569;background:#f8fafc;border:1px solid #cbd5e1;border-radius:8px;padding:.75rem 1rem;margin-bottom:1.5rem}a{color:#1d4ed8}.review-dashboard{border:1px solid #cbd5e1;border-radius:8px;background:#f8fafc;padding:1rem 1.1rem;margin:0 0 1.5rem}.review-dashboard h2{border:0;padding:0;margin:.1rem 0 .45rem}.review-dashboard ul{margin:.6rem 0 0;padding-left:1.2rem}.review-dashboard li{margin:.24rem 0}.comment-anchor{background:#fef3c7;padding:.04rem .1rem}.inline-review-note{border-left:4px solid #f59e0b;background:#fffbeb;padding:.75rem 1rem;margin:.5rem 0 1rem;border-radius:0 6px 6px 0}.inline-review-note h3{margin:0 0 .35rem}.inline-review-note p{margin:.25rem 0;white-space:pre-line}.comment-meta{color:#64748b;font-size:.82rem}@media(max-width:700px){main{margin:0;padding:28px 22px;box-shadow:none}}</style></head><body><main><div class="notice">${escapeHtml(note)}</div>${visible}</main></body></html>`;
}

function artifactBlock(identifier, title, html) {
	return `:::artifact{identifier="${slug(identifier)}" type="text/html" title="${escapeAttribute(title)}"}\n\`\`\`\`html\n${html}\n\`\`\`\`\n:::`;
}
function markdownArtifactBlock(identifier, title, markdown) {
	const safeTitle = String(title).replace(/[\"\r\n]/g, " ").trim().slice(0, 140) || "Legal document";
	const safeMarkdown = String(markdown).replace(/\r\n/g, "\n").replace(/\n:::\s*$/g, "\n").slice(0, MAX_PREVIEW_CHARS);
	return `:::artifact{identifier="${slug(identifier)}" type="text/markdown" title="${safeTitle}"}\n\`\`\`\`markdown\n${safeMarkdown}\n\`\`\`\`\n:::`;
}

function localName(node) { return node.localName || String(node.nodeName || "").replace(/^.*:/, ""); }
function attr(node, name) { return node.getAttribute(`w:${name}`) || node.getAttribute(name) || Array.from(node.attributes || []).find((item) => item.localName === name)?.value || ""; }
function childElements(node) { return Array.from(node.childNodes || []).filter((item) => item.nodeType === 1); }
function wordElements(node, name) { return Array.from(node.getElementsByTagNameNS(WORD_NS, name)); }
function nodeText(node) {
	let text = "";
	for (const child of Array.from(node.childNodes || [])) {
		if (child.nodeType === 3) text += child.nodeValue || "";
		else if (child.nodeType === 1) text += /^(br|cr)$/i.test(localName(child)) ? "\n" : localName(child) === "tab" ? "\t" : nodeText(child);
	}
	return text.replace(/\n{3,}/g, "\n\n").trim();
}
function parseXml(xml) {
	if (xml.length > MAX_XML_CHARS || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Unsafe or oversized DOCX XML");
	const errors = [];
	const parsed = new DOMParser({ errorHandler: { warning: () => undefined, error: (message) => errors.push(message), fatalError: (message) => errors.push(message) } }).parseFromString(xml, "application/xml");
	if (!parsed?.documentElement || errors.length || localName(parsed.documentElement) === "parsererror") throw new Error("Malformed DOCX XML");
	return parsed;
}
function comparable(value) { return String(value).replace(/<[^>]+>/g, " ").replace(/&(?:nbsp|amp|lt|gt);/gi, " ").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

async function docxAnnotations(bytes) {
	if (!bytes.length || bytes.length > MAX_DOCX_BYTES) return undefined;
	try {
		const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
		const commentsFile = zip.file("word/comments.xml");
		const documentFile = zip.file("word/document.xml");
		if (!commentsFile || !documentFile) return undefined;
		const comments = wordElements(parseXml(await commentsFile.async("string")), "comment").map((item) => ({ id: attr(item, "id"), author: attr(item, "author"), text: nodeText(item) })).filter((item) => item.id && item.text).slice(0, 500);
		if (!comments.length) return undefined;
		const valid = new Set(comments.map((item) => item.id));
		const active = new Set(); const paragraphs = [];
		const visit = (node, current) => {
			if (node.nodeType !== 1) return;
			const name = localName(node);
			if (name === "commentRangeStart") { const id = attr(node, "id"); if (valid.has(id)) active.add(id); return; }
			if (name === "commentRangeEnd") { active.delete(attr(node, "id")); return; }
			if (name === "p") {
				const paragraph = { text: "", commentIds: [] };
				for (const child of childElements(node)) visit(child, paragraph);
				paragraph.commentIds = [...new Set(paragraph.commentIds)];
				if (paragraph.text && paragraph.commentIds.length) paragraphs.push(paragraph);
				return;
			}
			if (name === "t" || name === "delText") { if (current) { current.text += nodeText(node); for (const id of active) current.commentIds.push(id); } return; }
			if (name === "tab" || name === "br" || name === "cr") { if (current) current.text += name === "tab" ? "\t" : "\n"; return; }
			for (const child of childElements(node)) visit(child, current);
		};
		visit(parseXml(await documentFile.async("string")).documentElement, undefined);
		return { comments, paragraphs: paragraphs.slice(0, 800) };
	} catch { return undefined; }
}

function injectAnnotations(mammothHtml, annotations) {
	if (!annotations?.paragraphs?.length) return mammothHtml;
	const comments = new Map(annotations.comments.map((item, index) => [item.id, { ...item, number: index + 1 }]));
	let cursor = 0;
	const converted = mammothHtml.replace(/<(p|h[1-6]|li|td)(\b[^>]*)>([\s\S]*?)<\/\1>/gi, (whole, tag, attributes, body) => {
		const matchIndex = annotations.paragraphs.findIndex((item, index) => index >= cursor && comparable(body).includes(comparable(item.text).slice(0, 35)));
		if (matchIndex < 0) return whole;
		cursor = matchIndex + 1;
		const item = annotations.paragraphs[matchIndex];
		const notes = item.commentIds.map((id) => comments.get(id)).filter(Boolean).map((comment) => `<aside class="inline-review-note" id="review-comment-${escapeAttribute(comment.id)}"><h3>Reviewer comment ${comment.number}</h3><p class="comment-meta">${escapeHtml(comment.author || "Reviewer")}</p><p>${escapeHtml(comment.text).replace(/\n/g, "<br>")}</p></aside>`).join("");
		return `<${tag}${attributes}><span class="comment-anchor">${body}</span></${tag}>${notes}`;
	});
	const dashboard = `<section class="review-dashboard"><h2>Review dashboard</h2><p>${annotations.comments.length} reviewer comment${annotations.comments.length === 1 ? "" : "s"}. Highlighted passages and notes are displayed at their original clauses below.</p></section>`;
	return `${dashboard}${converted}`;
}

async function docxPreview(filename, bytes) {
	const title = displayTitle(filename);
	const [converted, annotations] = await Promise.all([mammoth.convertToHtml({ buffer: bytes }), docxAnnotations(bytes)]);
	const body = sanitizeDocumentHtml(injectAnnotations(converted.value, annotations));
	const note = annotations ? "Browser preview converted from the reviewed DOCX. Reviewer comments are shown beside the relevant clauses. The downloadable DOCX remains the authoritative Word file." : "Browser preview converted from the DOCX. The downloadable DOCX remains the authoritative Word file.";
	return { title, kind: "docx", markup: artifactBlock(`${slug(title)}-preview`, `${title} — Preview`, documentHtml(title, body, note)) };
}

async function pdfPreview(filename, bytes) {
	const title = displayTitle(filename);
	const result = await pdfParse(bytes);
	const paragraphs = String(result.text || "").split(/\n{2,}/).map((line) => line.trim()).filter(Boolean).map((line) => `<p>${escapeHtml(line).replace(/\n/g, "<br>")}</p>`).join("");
	return { title, kind: "pdf", markup: artifactBlock(`${slug(title)}-preview`, `${title} — Preview`, documentHtml(title, paragraphs || "<p>No extractable PDF text was available.</p>", "Text preview generated locally from the PDF. The downloadable PDF remains the authoritative visual document.")) };
}

export async function preparePreview(filename, title) {
	const extension = path.extname(filename).toLowerCase();
	const bytes = await readFile(filename);
	const visibleTitle = title?.trim() || displayTitle(filename);
	if ([".md", ".markdown"].includes(extension)) return { title: visibleTitle, kind: "markdown", markup: markdownArtifactBlock(`${slug(visibleTitle)}-markdown`, visibleTitle, bytes.toString("utf8")) };
	if ([".txt", ".json"].includes(extension)) return { title: visibleTitle, kind: "text", markup: markdownArtifactBlock(`${slug(visibleTitle)}-text`, visibleTitle, `\`\`\`text\n${bytes.toString("utf8").slice(0, MAX_PREVIEW_CHARS)}\n\`\`\``) };
	if (extension === ".docx") return docxPreview(filename, bytes);
	if (extension === ".pdf") return pdfPreview(filename, bytes);
	throw new Error(`${path.basename(filename)} cannot be previewed; supported formats are DOCX, PDF, Markdown, text, and JSON`);
}

export { artifactBlock, markdownArtifactBlock };
