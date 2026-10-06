import { booleanEnv, env, requiredEnv } from "../core/environment.mjs";

function safeQuery(value) {
	const query = String(value || "").replace(/\s+/g, " ").trim();
	if (query.length < 3 || query.length > 320) throw new Error("Public web queries must be 3–320 characters.");
	if (/\b\d{9}[Vv]\b|\b0\d{9}\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/.test(query)) throw new Error("Do not send personal identifiers to public web search.");
	return query;
}

function markdown(items) {
	return items.map((item, index) => `${index + 1}. [${item.title || "Untitled source"}](${item.link})${item.date ? ` — ${item.date}` : ""}\n${String(item.snippet || "").trim()}`).join("\n\n");
}

export async function searchPublicLegalSources(args, { onProgress = () => {} } = {}) {
	if (!booleanEnv("WEB_SEARCH_ENABLED")) throw new Error("Web search is disabled by the administrator.");
	const query = safeQuery(args.query);
	onProgress("Searching current public sources…");
	const response = await fetch(env("WEB_SEARCH_BASE_URL", "https://google.serper.dev/search"), {
		method: "POST", headers: { "Content-Type": "application/json", "X-API-KEY": requiredEnv("WEB_SEARCH_API_KEY") },
		body: JSON.stringify({ q: query, num: Math.min(Math.max(Number(args.max_results || 6), 1), 10) }), signal: AbortSignal.timeout(25_000),
	});
	if (!response.ok) throw new Error(`Web search failed (${response.status}).`);
	const payload = await response.json();
	const items = (payload.organic || []).filter((item) => item?.link && /^https?:\/\//.test(item.link));
	return { query, sources: items, answer: `# Current public-source research\n\n${markdown(items)}\n\nUse these URLs exactly when relying on a source. Search results are leads; distinguish official legal sources from reporting.` };
}
