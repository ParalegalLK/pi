// The slot networks (task/plan.md, section 3.6; task P3.6). A slot is a small private network for one
// Pi container at a time: Pi at 10.89.<slot>.3 and the bridge at .2, and nothing else. Internal means
// no internet. The isolated gateway mode means the server itself has no address on the network, so Pi
// can't reach the server's ports. The runner creates the slots once, checks them, and keeps the bridge
// connected to every one.

const GATEWAY_MODE = "com.docker.network.bridge.gateway_mode_ipv4";

export function slotNetwork(slot) {
	return `js-slot-${slot}`;
}

export function slotSubnet(slot) {
	return `10.89.${slot}.0/24`;
}

export function bridgeAddress(slot) {
	return `10.89.${slot}.2`;
}

export function createSlotArgs(slot) {
	return ["network", "create", "--driver", "bridge", "--internal", "--opt", `${GATEWAY_MODE}=isolated`, "--subnet", slotSubnet(slot), "--label", "js.slot=1", slotNetwork(slot)];
}

// Why an existing network can't be used as this slot, or undefined when it's exactly right.
export function slotNetworkProblem(network, slot) {
	if (!network || typeof network !== "object") return "its settings couldn't be read";
	if (network.Driver !== "bridge") return "it isn't a bridge network";
	if (network.Internal !== true) return "it isn't internal, so Pi could reach the internet";
	if (network.Options?.[GATEWAY_MODE] !== "isolated") return "its gateway mode isn't isolated, so Pi could reach the server";
	if (network.EnableIPv6 === true) return "it has IPv6 turned on";
	const subnets = (network.IPAM?.Config ?? []).map((config) => config.Subnet);
	if (subnets.length !== 1 || subnets[0] !== slotSubnet(slot)) return `its address range isn't ${slotSubnet(slot)}`;
	if (network.Labels?.["js.slot"] !== "1") return "it isn't labelled as a slot";
	return undefined;
}

function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function firstLine(text) {
	return String(text || "").split("\n").find((line) => line.trim())?.trim().slice(0, 300) || "no reason given";
}

// Creates the slot's network if it's missing, refuses one with any wrong setting (a person should look,
// so it's never deleted), and connects the bridge at .2, reconnecting it if it's at another address.
// docker(args) runs one docker command. Returns { ok: true, changes } or { ok: false, problem }.
export async function ensureSlot(slot, { docker, bridgeContainer }) {
	const name = slotNetwork(slot);
	const changes = [];
	let inspected = await docker(["network", "inspect", "--format", "{{json .}}", name]);
	if (inspected.code !== 0) {
		const created = await docker(createSlotArgs(slot));
		if (created.code !== 0) return { ok: false, problem: `${name} couldn't be created: ${firstLine(created.stderr)}` };
		changes.push(`created ${name}`);
		inspected = await docker(["network", "inspect", "--format", "{{json .}}", name]);
	}
	const problem = slotNetworkProblem(parseJson(inspected.stdout), slot);
	if (problem) return { ok: false, problem: `${name} can't be used: ${problem}` };

	const bridge = await docker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", bridgeContainer]);
	if (bridge.code !== 0) return { ok: false, problem: `the bridge container ${bridgeContainer} isn't there` };
	const joined = parseJson(bridge.stdout)?.[name];
	const address = bridgeAddress(slot);
	// The fixed address must be reserved for the bridge, not just happen to be the one it got.
	if (joined?.IPAMConfig?.IPv4Address === address) return { ok: true, changes };
	if (joined) await docker(["network", "disconnect", "--force", name, bridgeContainer]);
	const connected = await docker(["network", "connect", "--ip", address, name, bridgeContainer]);
	if (connected.code !== 0) return { ok: false, problem: `the bridge couldn't join ${name}: ${firstLine(connected.stderr)}` };
	changes.push(`connected the bridge to ${name} at ${address}`);
	return { ok: true, changes };
}
