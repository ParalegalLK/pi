# Maintaining the ParalegalLK Pi fork

This guide maintains [ParalegalLK/pi](https://github.com/ParalegalLK/pi) while keeping Junior Silva V2 intact as Pi evolves.

## Branch model

| Branch or remote | Purpose |
|---|---|
| upstream/main | The original Earendil Pi project. Never push here. It is the source for Pi upgrades. |
| main | ParalegalLK's stable Pi plus the Junior Silva V2 baseline. It is deliberately not a clean upstream mirror. |
| dev | The integration and development branch. It receives stable main and may contain upcoming work. |
| feat/deployment-test | The current tested Junior Silva V2 implementation before promotion. |
| backup/* | Timestamped recovery branches made before each important integration. |

The repository should have these remotes:

~~~powershell
git remote -v
# origin   https://github.com/ParalegalLK/pi.git
# upstream https://github.com/earendil-works/pi.git
~~~

Never force-push main or dev. Never use git reset --hard to resolve an integration. Never choose "ours" or "theirs" blindly: preserve the intent of both changes.

## A. First promotion: deployment-test to main and dev

Run this in PowerShell:

~~~powershell
cd "D:\Intern\Work\Junior Silva V2\pi"

git status --short
git fetch origin --prune
git fetch upstream --prune --tags
git branch --show-current
~~~

Stop if the working tree is not clean. Commit or stash deliberately first, and confirm the current deployment-test branch has already been pushed.

### 1. Make recovery branches

~~~powershell
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

git switch main
git pull --ff-only origin main
git branch "backup/main-before-junior-silva-v2-$stamp"
git push origin "backup/main-before-junior-silva-v2-$stamp"

git switch dev
git pull --ff-only origin dev
git branch "backup/dev-before-junior-silva-v2-$stamp"
git push origin "backup/dev-before-junior-silva-v2-$stamp"
~~~

### 2. Promote the tested implementation into main

~~~powershell
git switch main
git merge --no-ff feat/deployment-test -m "Merge Junior Silva V2 deployment implementation"
~~~

If Git reports conflicts, follow section C. When the merge is resolved:

~~~powershell
git diff --check
git status
# Run section D validation.
git push origin main
~~~

### 3. Bring the promoted main into dev

Use main to dev rather than merging the feature branch into both separately. This means dev receives exactly the stable V2 baseline, plus any development work already in dev.

~~~powershell
git switch dev
git pull --ff-only origin dev
git merge --no-ff main -m "Merge stable Junior Silva V2 baseline from main"
# Resolve any dev-specific conflicts and run section D validation.
git push origin dev
~~~

### 4. Confirm the result

~~~powershell
git log --graph --oneline --decorate --all -n 50
git branch --contains feat/deployment-test
~~~

Both main and dev should contain the deployment-test commits. Keep the feature branch until deployment has been verified.

## B. Integrating a future upstream Pi update

Do not merge an upstream update directly into a production branch. Merge it first on a new integration branch based on the current ParalegalLK main.

### 1. Inspect the available update

~~~powershell
cd "D:\Intern\Work\Junior Silva V2\pi"

git status --short
git fetch upstream --prune --tags
git fetch origin --prune

git log --oneline main..upstream/main
git diff --stat main...upstream/main
git tag --sort=-version:refname | Select-Object -First 20
~~~

### 2. Back up main and dev

~~~powershell
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

git switch main
git pull --ff-only origin main
git branch "backup/main-before-upstream-$stamp"
git push origin "backup/main-before-upstream-$stamp"

git switch dev
git pull --ff-only origin dev
git branch "backup/dev-before-upstream-$stamp"
git push origin "backup/dev-before-upstream-$stamp"
~~~

### 3. Create an integration branch and merge upstream

Replace the date with the Pi version or date being integrated.

~~~powershell
git switch main
git switch -c "chore/merge-pi-upstream-YYYY-MM-DD"
git merge --no-ff upstream/main -m "Merge upstream Pi updates"
~~~

Resolve conflicts under section C. Do not promote this branch until it passes section D.

### 4. Validate, then publish the integration branch

~~~powershell
git push -u origin "chore/merge-pi-upstream-YYYY-MM-DD"
~~~

Review its final diff carefully before promotion.

### 5. Promote the tested integration to main, then dev

~~~powershell
git switch main
git merge --no-ff "chore/merge-pi-upstream-YYYY-MM-DD" -m "Promote upstream Pi integration"
git push origin main

git switch dev
git pull --ff-only origin dev
git merge --no-ff main -m "Merge updated stable Pi baseline"
git push origin dev
~~~

If dev has active work, resolve and test it as a separate integration target.

## C. Conflict-resolution procedure

### 1. Inspect the conflict before editing

~~~powershell
git status
git diff --name-only --diff-filter=U
git diff --merge
git log --oneline --left-right --merge

git show :1:path/to/file   # merge base
git show :2:path/to/file   # current branch, ours
git show :3:path/to/file   # incoming branch, theirs
~~~

Read every conflicted file and all three versions. Retain upstream Pi behaviour and Junior Silva V2 behaviour rather than treating either as disposable.

### 2. Files needing deliberate V2 preservation

~~~text
.pi/extensions/junior-silva-legal-context.ts
.pi/extensions/legal-research-citation-delivery.ts
.pi/extensions/librechat-preview-delivery.ts
.pi/mcp.json
.agents/skills/
junior-silva/core/
junior-silva/mcp/
junior-silva/server/
junior-silva/services/
junior-silva/review/
junior-silva/cli/
Dockerfile
docker-compose.yml
Start-JuniorSilvaV2.ps1
.env.example
Architecture.md
Overview.md
History.md
TESTING.md
~~~

The resolved tree must preserve:

- direct Junior Silva legal MCP tools and their contracts;
- native multi-document reviews, later-turn evidence checkpoint, source anchoring, comments/highlights, protected downloads, and previews;
- RAG links and citations, plus Lex/Typesense source-detail retrieval;
- Asia/Colombo current-time awareness and legal-only scope;
- LibreChat provider-file and Upload-as-Text attachment handling;
- safe progress messages that never expose API keys, local paths, raw shell commands, or raw service responses;
- OpenAI-compatible streaming and persistent usage reporting; and
- Pi built-in tools for document-skill scripts, unless deliberately redesigned and revalidated.

### 3. Finish or abort safely

For each resolved file:

~~~powershell
git add path/to/resolved-file
git diff --cached --check
git status
~~~

When every conflict is resolved:

~~~powershell
git commit
~~~

If the merge is unsafe or cannot be resolved:

~~~powershell
git merge --abort
~~~

This returns the branch to its pre-merge state. The timestamped backup branches are a second recovery point.

### Codex prompt for a conflict-resolution task

~~~text
We are integrating upstream Pi into ParalegalLK/pi. Resolve the current Git merge conflicts carefully.

First read Architecture.md, Overview.md, History.md, TESTING.md, the conflicted files in full, and the merge-base/ours/theirs versions. Do not use a blanket ours/theirs choice. Preserve upstream Pi improvements while preserving all Junior Silva V2 behaviour.

Junior Silva requirements that must remain intact include: direct legal MCP tools; native multi-document reviews with a real later-turn evidence checkpoint; source-anchored comments/highlights in reviewed DOCX files; private clean-kb precedent access only for structure; RAG citation and hyperlink preservation; Lex/Typesense detail retrieval; current Colombo time; legal-only scope; LibreChat Upload-as-Text and provider-file handling; safe progress without secrets or shell output; protected downloads and previews; OpenAI-compatible streaming and persistent token usage; and Pi built-in tools for document skills.

Do not put API keys, .env values, personal documents, generated artifacts, session logs, or node_modules into Git. Do not modify LibreChat itself. Keep paths portable between Windows local CLI and Docker/Linux unless a platform-specific script already exists.

After resolving, run the targeted Junior Silva tests, git diff --check, Docker Compose configuration validation, and inspect the final diff. Explain every non-trivial conflict decision and any validation limitation before asking me to commit or deploy.
~~~

## D. Required validation and secret checks

Run the newest or changed behaviour tests first, then the broader checklist in [TESTING.md](TESTING.md). At minimum:

~~~powershell
git diff --check

docker compose config | Out-File -Encoding utf8 .tmp-compose-config.yml
Remove-Item .tmp-compose-config.yml

$tests = Get-ChildItem -Path junior-silva/test -Filter '*.test.mjs' | ForEach-Object FullName
node --test $tests
docker compose build junior-silva-v2
~~~

Before committing, check staged files for secrets or generated user data:

~~~powershell
$blocked = git diff --cached --name-only | Where-Object {
  $_ -match '(^|/)\.env$|\.pem$|\.key$|credentials|sessions|uploads|artifacts'
}
if ($blocked) {
  throw "Possible secret or generated file staged."
}
git diff --cached --check
~~~

The root Pi Husky check can fail because of a known unrelated upstream Together-model TypeScript test. Do not hide a relevant failure. If that is the only failure and the targeted V2 checks pass, document it in the commit or PR and use this narrow bypass:

~~~powershell
$env:HUSKY = '0'
git commit -m "Describe the tested integration"
Remove-Item Env:HUSKY
~~~

## E. Recovery without rewriting shared history

If a promoted result must be investigated or restored, compare it to the appropriate backup and work on a new recovery branch:

~~~powershell
git switch -c recovery/from-main-backup backup/main-before-upstream-YYYYMMDD-HHMMSS
git push -u origin recovery/from-main-backup
~~~

Do not rewrite shared main or dev history. Use the recovery branch to identify the exact corrective commit, validate it, then merge that correction normally.
