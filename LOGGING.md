# Junior Silva V2 local trace logs

Junior Silva writes one structured trace for each OpenAI-compatible request and each direct Pi CLI turn. It does not send traces to MongoDB or to any external logging service.

## Location

The default location is `junior-silva/logs/traces/<UTC-date>/<request-id>/` in a native checkout. Docker mounts the same host directory at `/data/logs`, so traces survive a container recreation.

Set these optional `.env` values to control logging:

```dotenv
JUNIOR_SILVA_TRACE_LOGS=true
JUNIOR_SILVA_LOG_ROOT=
JUNIOR_SILVA_LOG_MAX_VALUE_BYTES=262144
```

Set `JUNIOR_SILVA_TRACE_LOGS=false` to disable new traces. Set `JUNIOR_SILVA_LOG_ROOT` to an absolute writable path only when the default path is unsuitable.

## Files per request

- `trace.json` is the current structured summary, written when the request completes or fails.
- `events.jsonl` is an append-only chronological event stream for progressive inspection.

`trace.json` contains:

- request, Pi session and conversation identifiers; start/end time, outcome and elapsed time;
- original user query and attachment metadata (original name, stored path, size, checksum, and whether it was newly supplied on that turn);
- every Pi model response with provider, model, stop reason and token usage when Pi supplies it;
- every tool call in order, including its arguments, progress updates, result, status, duration and produced artifact references;
- final response, OpenAI-compatible token usage, delivered artifacts and requested LibreChat previews.

Large strings are capped at `JUNIOR_SILVA_LOG_MAX_VALUE_BYTES` and recorded with their original byte count and SHA-256. Credential-shaped fields, configured secret values, Bearer-style values and sensitive URL query parameters are replaced with `[REDACTED]` before writing either file.

## Inspecting a recent Docker trace

```bash
cd ~/app/junior-silva-v2
find junior-silva/logs/traces -name trace.json -printf '%T@ %p\n' | sort -nr | head

# Replace the path with one from the previous command.
jq '.' junior-silva/logs/traces/2026-10-27/chatcmpl-.../trace.json
tail -f junior-silva/logs/traces/2026-10-27/chatcmpl-.../events.jsonl
```

## Viewing local traces

`D:\Intern\Work\logs server` includes a read-only file adapter for Junior Silva traces. It scans the local checkout recursively at:

```text
D:\Intern\Work\Junior Silva V2\pi\junior-silva\logs\traces
```

Open the local viewer at [http://localhost:3002/chatlogs](http://localhost:3002/chatlogs). It groups all turns with the same Junior Silva `conversation_key` into one session, so an initial review request, a clarification checkpoint, a reply such as `review normally`, and later supporting uploads appear in chronological order in one record.

The **Tools used** section is expandable and contains the redacted request, progress updates, result, duration and artifact references for each tool call. Rag Chat records continue to appear as their existing individual records.

## Importing deployed-server traces into the local viewer

Server traces use the identical schema. The Compose deployment bind-mounts the trace directory to the server checkout, so copy it directly from the server into one stable local import directory, then refresh the viewer. The reader scans recursively, so no code or configuration change is required.

### Copy it to the Windows development machine

In Windows PowerShell:

```powershell
$serverTraceRoot = '~/app/junior-silva-v2/junior-silva/logs/traces'
$localImport = 'D:\Intern\Work\Junior Silva V2\pi\junior-silva\logs\traces\server-chat-dev'

New-Item -ItemType Directory -Force -Path $localImport | Out-Null
scp -r "paralegaluser@chat-dev:$serverTraceRoot/." $localImport
Get-ChildItem -Recurse -File $localImport -Filter trace.json | Measure-Object
```

This creates a separate, stable import folder rather than merging files into native local traces. Re-run the same command later to update that folder with the server's current trace tree. Do not use a new dated destination for a full-copy sync: the viewer would otherwise see duplicate copies of the same request trace.

If the `chat-dev` SSH alias is configured only in WSL (rather than in Windows `%USERPROFILE%\.ssh\config`), run the copy through WSL instead. It writes to the same local directory:

```bash
local_import='/mnt/d/Intern/Work/Junior Silva V2/pi/junior-silva/logs/traces/server-chat-dev'
mkdir -p "$local_import"
scp -r 'chat-dev:~/app/junior-silva-v2/junior-silva/logs/traces/.' "$local_import"
find "$local_import" -type f -name trace.json | wc -l
```

### View the imported sessions

1. Ensure the local file-backed logs API and viewer are running.
2. Refresh [http://localhost:3002/chatlogs](http://localhost:3002/chatlogs).
3. Server sessions appear alongside local sessions. Select one to see its turns, **Tools used**, token totals, artifacts and redacted technical trace.

The reader loads files on each API request. A viewer/API restart is not required after a new import; refresh the browser instead.

## Handling

Trace files can contain user legal documents, queries and tool results. Restrict filesystem access, keep the directory out of Git, and set an operational retention policy before production use.
