export function linkedAuthorities(answer) {
	const seen = new Set();
	return [...String(answer || "").matchAll(/\[([^\]\r\n]+)\]\((https?:\/\/[^\s)]+)\)/g)]
		.map((match) => ({ label: match[1].trim(), url: match[2] }))
		.filter((item) => item.label && item.url && !seen.has(`${item.label}\0${item.url}`) && (seen.add(`${item.label}\0${item.url}`), true));
}

export function researchDelivery(answer) {
	const content = String(answer || "").trim();
	return {
		mode: "verbatim_for_direct_research",
		instruction: "For a direct legal-research request, return answer verbatim. Preserve every Markdown hyperlink, heading, authority, and conclusion. Do not replace linked authorities with plain text.",
		linked_authorities: linkedAuthorities(content),
	};
}
