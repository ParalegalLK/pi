// Isolation check (task/plan.md, section 7; task P3.15): prints the exact `docker run` arguments the
// runner uses for a Pi run, from its own piRunArgs(), but for a probe instead of Pi. Only three things
// differ: the name and the label, so the runner's sweep leaves the probe alone, and what runs inside.
// Everything that makes the walls stays the same: the runtime, the slot, the mounts, the user, the
// read-only system, the dropped powers and the limits.
//
//   node probe-args.mjs '<json>'
//   json: { requestId, userHash, chatHash, slot, settings: { hostDataRoot, image, slots, gatewayPort },
//           name, entrypoint, command: [...] }
// Prints the arguments separated by NUL characters, for `mapfile -d ''` in js-isolation-check.sh.
import { piRunArgs } from "../../runner/docker-args.mjs";

const input = JSON.parse(process.argv[2]);
const args = piRunArgs({ requestId: input.requestId, userHash: input.userHash, chatHash: input.chatHash, slot: input.slot, provider: "anthropic", model: "isolation-check" }, input.settings);
const nameAt = args.indexOf("--name");
const labelAt = args.indexOf("--label");
const imageAt = args.lastIndexOf(input.settings.image);
if (nameAt < 0 || labelAt < 0 || imageAt < 0 || !/^js-check-[a-z0-9-]+$/.test(input.name)) throw new Error("unexpected runner arguments or probe name");
args[nameAt + 1] = input.name;
args[labelAt + 1] = "js.check=isolation";
const probe = [...args.slice(0, imageAt), "--entrypoint", input.entrypoint, input.settings.image, ...input.command];
process.stdout.write(`${probe.join("\0")}\0`);
