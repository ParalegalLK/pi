# Isolation check (task/plan.md, section 7; task P3.15): searches the Pi image for anything it must not
# hold. It reads the image's files as a tar stream on stdin (docker export), plus extra text files such as
# its build history and settings. Secret values are only held in memory: it prints how many files and
# settings it searched, and the names of any settings whose value it found, never a value.
#
#   docker export <container> | python3 -I image-scan.py <env file> [more text files]
#
# Prints PASS or FAIL lines for js-isolation-check.sh, and exits with the number of failures.
import re
import sys
import tarfile

CHUNK = 8 * 1024 * 1024
SECRET_NAME = re.compile(r"KEY|SECRET|TOKEN|PASSWORD|PASSWD|AUTH|CREDENTIAL|PRIVATE", re.I)
TOKEN_LIKE = re.compile(r"^[A-Za-z0-9_\-.=+]{24,}$")
# The only Junior Silva files the Pi image may hold: the scope rules its extensions use, and the
# forward-only tool launcher. Everything else under junior-silva/ is bridge code.
ALLOWED_CODE = {"app/junior-silva/core/legal-scope.mjs", "app/junior-silva/mcp/launcher.mjs"}

env_file, *extra_files = sys.argv[1:]
secrets = {}
for line in open(env_file, encoding="utf8"):
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    name, value = line.split("=", 1)
    name = name.strip().removeprefix("export ").strip()
    value = value.strip().strip('"').strip("'")
    if (SECRET_NAME.search(name) and len(value) >= 8) or TOKEN_LIKE.match(value):
        secrets[name] = value.encode()
names_by_value = {}
for name, value in secrets.items():
    names_by_value.setdefault(value, []).append(name)
pattern = re.compile(b"|".join(re.escape(value) for value in sorted(names_by_value, key=len, reverse=True))) if secrets else None
overlap = max((len(value) for value in names_by_value), default=1) - 1

found = set()
env_files = []
bridge_code = []
searched = 0


def search(read):
    previous = b""
    while True:
        chunk = read(CHUNK)
        if not chunk:
            return
        window = previous + chunk
        for match in pattern.finditer(window):
            found.update(names_by_value[match.group(0)])
        previous = window[-overlap:] if overlap else b""


with tarfile.open(fileobj=sys.stdin.buffer, mode="r|") as archive:
    for member in archive:
        name = member.name.removeprefix("./").removeprefix("/")
        if re.search(r"(^|/)\.env(\.[^/]+)?$", name) and not name.endswith(".env.example"):
            env_files.append(name)
        if name.startswith("app/junior-silva/") and member.isfile() and name not in ALLOWED_CODE:
            bridge_code.append(name)
        if member.isfile() and pattern is not None:
            handle = archive.extractfile(member)
            if handle is not None:
                search(handle.read)
                searched += 1

for path in extra_files:
    with open(path, "rb") as handle:
        if pattern is not None:
            search(handle.read)

failures = 0


def report(ok, text):
    global failures
    print(f"{'PASS' if ok else 'FAIL'} images {text}")
    if not ok:
        failures += 1


report(not found, f"searched {searched} files and {len(extra_files)} history and settings files for the values of {len(secrets)} settings ({', '.join(sorted(secrets))}): " + (f"FOUND the values of {', '.join(sorted(found))}" if found else "none found"))
report(not env_files, "no .env file in the image" if not env_files else f".env files: {', '.join(env_files[:5])}")
report(not bridge_code, "no bridge code: under junior-silva/ only the scope rules and the forward-only launcher" if not bridge_code else f"bridge code found: {', '.join(bridge_code[:5])}{' …' if len(bridge_code) > 5 else ''}")
sys.exit(failures)
