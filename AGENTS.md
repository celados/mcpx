# Agent instructions

## Agent skills

### Issue tracker

Issues and build specifications are tracked in GitHub Issues for `celados/mcpx`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical triage labels defined in `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. Read `GLOSSARY.md` and relevant ADRs under `docs/adr/`. See `docs/agents/domain.md`.

## Local install after every change

On the user's machines `mcpx` is the release bundle in `~/.local/bin`,
installed by the workspace `update-local-tool` skill. A change is not done when
it merges or releases. It is done when the user's local `mcpx` runs it. The
user does not watch for this, so do it without being asked:

1. After the release workflow for your change succeeds, check whether the tool is
   installed: `command -v mcpx`. If it is not, stop here.
2. Run `bash ~/workspace/.agents/skills/update-local-tool/update.sh mcpx`. It prints `before -> after`.
3. Check your change with the installed binary, for example `mcpx @schema` or the
   command you changed.
4. Put the `before -> after` line in your final report.

If the release failed, report that. Don't install a local build in its place.
