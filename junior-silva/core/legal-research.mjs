export function linkedAuthorities(answer) {
	const seen = new Set();
	return [...String(answer || "").matchAll(/\[([^\]\r\n]+)\]\((https?:\/\/[^\s)]+)\)/g)]
		.map((match) => ({ label: match[1].trim(), url: match[2] }))
		.filter((item) => item.label && item.url && !seen.has(`${item.label}\0${item.url}`) && (seen.add(`${item.label}\0${item.url}`), true));
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
