import assert from "node:assert/strict";
import test from "node:test";
import { bridgeAddress, createSlotArgs, slotNetwork, slotNetworkProblem, slotSubnet } from "../runner/slots.mjs";

// A slot network as `docker network inspect` prints it, with the settings the plan needs.
function rightNetwork(slot) {
	return {
		Name: `js-slot-${slot}`,
		Driver: "bridge",
		Internal: true,
		EnableIPv6: false,
		Options: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" },
		IPAM: { Driver: "default", Config: [{ Subnet: `10.89.${slot}.0/24`, Gateway: `10.89.${slot}.1` }] },
		Labels: { "js.slot": "1" },
	};
}

test("a slot network is created with exactly the plan's settings", () => {
	assert.deepEqual(createSlotArgs(2), [
		"network", "create", "--driver", "bridge", "--internal",
		"--opt", "com.docker.network.bridge.gateway_mode_ipv4=isolated",
		"--subnet", "10.89.2.0/24", "--label", "js.slot=1", "js-slot-2",
	]);
	assert.equal(slotNetwork(3), "js-slot-3");
	assert.equal(slotSubnet(3), "10.89.3.0/24");
	assert.equal(bridgeAddress(3), "10.89.3.2");
});

test("a slot network with exactly the right settings can be used", () => {
	assert.equal(slotNetworkProblem(rightNetwork(1), 1), undefined);
});

test("each wrong setting gives its own reason, so the slot isn't used", () => {
	const wrong = (change) => ({ ...rightNetwork(1), ...change });
	const cases = [
		[undefined, /couldn't be read/],
		[wrong({ Driver: "overlay" }), /isn't a bridge network/],
		[wrong({ Internal: false }), /isn't internal/],
		[wrong({ Options: {} }), /gateway mode isn't isolated/],
		[wrong({ Options: { "com.docker.network.bridge.gateway_mode_ipv4": "nat" } }), /gateway mode isn't isolated/],
		[wrong({ EnableIPv6: true }), /IPv6/],
		[wrong({ IPAM: { Config: [{ Subnet: "10.89.9.0/24" }] } }), /address range isn't 10\.89\.1\.0\/24/],
		[wrong({ IPAM: { Config: [{ Subnet: "10.89.1.0/24" }, { Subnet: "fd00::/64" }] } }), /address range/],
		[wrong({ IPAM: { Config: [] } }), /address range/],
		[wrong({ Labels: {} }), /isn't labelled as a slot/],
	];
	for (const [network, reason] of cases) assert.match(String(slotNetworkProblem(network, 1)), reason, JSON.stringify(network));
	assert.match(String(slotNetworkProblem(rightNetwork(2), 1)), /address range/, "slot 2's network can't be slot 1");
});
