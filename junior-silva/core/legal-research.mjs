export function linkedAuthorities(answer) {
	const seen = new Set();
	return [...String(answer || "").matchAll(/\[([^\]\r\n]+)\]\((https?:\/\/[^\s)]+)\)/g)]
		.map((match) => ({ label: match[1].trim(), url: match[2] }))
		.filter((item) => item.label && item.url && !seen.has(`${item.label}\0${item.url}`) && (seen.add(`${item.label}\0${item.url}`), true));
}

function cleanAuthorityName(value) {
	return String(value || "").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function authorityCandidates(value) {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		const label = typeof item.label === "string" ? item.label.trim() : "";
		const url = typeof item.url === "string" ? item.url.trim() : "";
		return label && /^https?:\/\//i.test(url) ? [{ label, url, aliases: [label] }] : [];
	});
}

// RAG often places a readable case name immediately before a linked neutral
// citation. Keep both forms so Pi can retain the source link when it uses
// either form in its own synthesis.
export function enrichAuthorityAliases(answer, authorities) {
	const text = String(answer || "");
	return authorities.map((authority) => {
		const aliases = new Set(authority.aliases.map(cleanAuthorityName).filter(Boolean));
		const escapedUrl = escapeRegExp(authority.url);
		const linkedCitation = new RegExp(`(?:\\*{1,2}([^*\\n]{3,160})\\*{1,2}|([A-Z][^\\n.]{3,150}?\\s+v\\.?\\s+[A-Z][^\\n.]{2,150}))\\s*\\(\\s*\\[?${escapeRegExp(authority.label)}\\]?\\(${escapedUrl}\\)\\s*\\)`, "gi");
		for (const match of text.matchAll(linkedCitation)) {
			const name = cleanAuthorityName(match[1] || match[2]);
			if (name) aliases.add(name);
		}
		return { ...authority, aliases: [...aliases].sort((a, b) => b.length - a.length) };
	});
}

export function mergeAuthorityCandidates(existing, incoming) {
	const merged = new Map();
	for (const authority of [...existing, ...incoming]) {
		const key = `${authority.label}\0${authority.url}`;
		const known = merged.get(key);
		if (!known) {
			merged.set(key, { ...authority, aliases: [...new Set(authority.aliases)] });
			continue;
		}
		known.aliases = [...new Set([...known.aliases, ...authority.aliases])].sort((a, b) => b.length - a.length);
	}
	return [...merged.values()];
}

function linkifyOutsideMarkdown(text, label, url) {
	if (!label || text.includes(`](${url})`)) return text;
	const pieces = text.split(/(\[[^\]\r\n]+\]\(https?:\/\/[^\s)]+\))/g);
	const expression = new RegExp(`(^|[^\\w])(${escapeRegExp(label)})(?=$|[^\\w])`, "gi");
	return pieces.map((piece) => {
		if (/^\[[^\]\r\n]+\]\(https?:\/\//.test(piece)) return piece;
		return piece.replace(expression, (_whole, before, matched) => `${before}[${matched}](${url})`);
	}).join("");
}

// A research tool may return more authorities than Pi ultimately relies on.
// Link only authorities the final answer actually names; never append a
// detached source list that implies an unmade proposition.
export function linkifyCitedAuthorities(text, authorities) {
	if (!String(text || "").trim() || !Array.isArray(authorities)) return text;
	let output = text;
	for (const authority of authorities) {
		for (const alias of authority.aliases || []) output = linkifyOutsideMarkdown(output, alias, authority.url);
	}
	return output;
}

export function researchDelivery(answer, mode = "direct_answer") {
	const content = String(answer || "").trim();
	return {
		mode,
		instruction: mode === "supporting_work_product"
			? "This research supports a separate user-requested work product. Preserve every authority URL for each legal proposition retained in that work product; do not invent or substitute citations."
			: "For a direct legal-research request, return answer verbatim. Preserve every Markdown hyperlink, heading, authority, and conclusion. Do not replace linked authorities with plain text.",
		linked_authorities: linkedAuthorities(content),
	};
}
