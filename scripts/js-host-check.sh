#!/usr/bin/env bash
# Read-only host facts for the isolation plan: checks H1 to H8 in task/plan.md.
# Changes nothing and prints no secrets. Safe to run on a server:
#
#   ssh <server> 'bash -s' < scripts/js-host-check.sh
set -u

section() { printf '\n== %s\n' "$1"; }

section "H1 CPU type"
uname -m

section "H2 Kernel and OS"
uname -r
if [ -r /etc/os-release ]; then
	. /etc/os-release
	echo "${PRETTY_NAME:-unknown}"
fi

section "H3 Docker"
docker version --format 'client {{.Client.Version}} server {{.Server.Version}}' 2>&1
docker info --format 'storage={{.Driver}} cgroup={{.CgroupDriver}}/{{.CgroupVersion}} runtimes={{range $name, $_ := .Runtimes}}{{$name}} {{end}}' 2>&1
docker compose version 2>&1

section "H4 RAM and CPU"
free -h | sed -n 1,2p
nproc

section "H5 Disk"
df -h / /var/lib/docker 2>/dev/null

section "H6 Open TCP ports"
if command -v ss >/dev/null; then
	ss -tln | awk 'NR>1 {print $4}' | sort -u
else
	echo "ss not available"
fi

section "H7 Is 10.89.0.0/16 free?"
if ip -4 route 2>/dev/null | grep -q '^10\.89\.'; then
	echo "IN USE by a route:"
	ip -4 route | grep '^10\.89\.'
else
	echo "No route uses it"
fi
docker network ls -q 2>/dev/null | xargs -r docker network inspect --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null

section "H8 Docker group and user"
getent group docker
id

section "Also useful: KVM and gVisor"
ls -l /dev/kvm 2>/dev/null || echo "no /dev/kvm"
if command -v runsc >/dev/null; then
	runsc --version | head -2
else
	echo "runsc not installed"
fi

section "Also useful: running containers"
docker ps --format '{{.Names}} | {{.Image}} | {{.Status}} | {{.Ports}}' 2>&1

section "Also useful: networks of each container"
for name in $(docker ps --format '{{.Names}}' 2>/dev/null); do
	printf '%s: ' "$name"
	docker inspect -f '{{range $net, $conf := .NetworkSettings.Networks}}{{$net}}={{$conf.IPAddress}} {{end}}' "$name"
done

# Addresses only, to show whether anything besides LibreChat uses these.
section "Also useful: client addresses connected to MongoDB and Redis"
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx chat-mongodb; then
	docker exec chat-mongodb mongosh --quiet --eval '[...new Set(db.adminCommand({ currentOp: 1, $all: true }).inprog.map((op) => String(op.client || "").split(":")[0]).filter(Boolean))].forEach((ip) => print("mongodb client " + ip))' 2>&1 | cut -c1-80
else
	echo "chat-mongodb not running"
fi
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx librechat-redis; then
	docker exec librechat-redis redis-cli client list 2>&1 | grep -oE 'addr=[0-9.]+' | sort -u | sed 's/addr=/redis client /'
else
	echo "librechat-redis not running"
fi
