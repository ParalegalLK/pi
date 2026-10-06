const TIME_ZONE = "Asia/Colombo";

export function colomboNow(date = new Date()) {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: TIME_ZONE,
		dateStyle: "full",
		timeStyle: "long",
		hour12: false,
	}).formatToParts(date);
	const pick = (type) => parts.find((part) => part.type === type)?.value || "";
	return {
		iso: date.toISOString(),
		display: `${pick("weekday")}, ${pick("day")} ${pick("month")} ${pick("year")}, ${pick("hour")}:${pick("minute")}:${pick("second")} ${TIME_ZONE} (${pick("timeZoneName")})`,
	};
}

export function temporalContext(date = new Date()) {
	const now = colomboNow(date);
	return `Authoritative current date and time: ${now.display}. Use this runtime date, not model-training assumptions, when deciding whether a dated event is past or future. For current-status questions, distinguish the event date, source publication date, Gazette date, and legal commencement date. Do not describe a date before this runtime date as future.`;
}
