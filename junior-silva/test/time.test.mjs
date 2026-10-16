import assert from "node:assert/strict";
import test from "node:test";
import { colomboNow, temporalContext } from "../core/time.mjs";

test("temporal context supplies the live Sri Lankan time zone and chronology rule", () => {
	const date = new Date("2026-10-01T00:30:00.000Z");
	const now = colomboNow(date);
	const context = temporalContext(date);

	assert.match(now.display, /1 October 2026/);
	assert.match(now.display, /Asia\/Colombo/);
	assert.match(context, /Authoritative current date and time/);
	assert.match(context, /before this runtime date as future/);
});
