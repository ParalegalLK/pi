// Build-time check for the Pi sandbox image (Dockerfile, stage pi-sandbox).
// Pi's bundle loads jiti and photon-node from node_modules at run time, so they must be the
// versions Pi is built with. If a Pi upgrade changes them, the build stops here instead of
// Pi failing later inside a chat.
import { readFileSync } from "node:fs";

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const builtWith = readJson("/app/packages/coding-agent/package.json").dependencies;
let mismatched = false;
for (const name of ["jiti", "@silvia-odwyer/photon-node"]) {
	const installed = readJson(`/app/node_modules/${name}/package.json`).version;
	if (installed !== builtWith[name]) {
		console.error(
			`${name} is ${installed} in deploy/pi-libs, but Pi is built with ${builtWith[name]}. Update deploy/pi-libs/package.json and its lockfile.`,
		);
		mismatched = true;
	}
}
if (mismatched) process.exit(1);
console.log("jiti and photon-node match the versions Pi is built with.");
