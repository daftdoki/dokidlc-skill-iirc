# Developing iirc

## Layout

```
.claude-plugin/plugin.json   manifest; no version field, the commit is the version
bin/iirc                   the command; Python under uv run --script, PyYAML inline
bin/iirc_embed.py          the model table, the embedding backends, and the vector store
bin/iirc-cpu               all-MiniLM-L6-v2 through onnxruntime, its own uv script
bin/iirc_words.txt         common English words, CC-BY-SA (NOTICE); scripts/common-words.py rebuilds it
iirc.pin                   memoryfield-tool commit and the embedding model
scripts/                   guard.sh, the replay builders and the session replay, screenshots and demo
skills/iirc/SKILL.md       the agent's rules
hooks/hooks.json             SessionStart and SubagentStart: doctor --brief --hook; UserPromptSubmit and PostToolUseFailure: suggest-pages; PostToolUse: record-command-success; Stop: remind-to-write; PreCompact and SessionEnd: record-session-summary; PreToolUse (Bash, Read): guard
tests/                       pytest; nothing needs ollama or memoryfield-tool
```

`bin/iirc` uses memoryfield-tool, as published at the commit in
`iirc.pin`, to write, delete, and validate pages. It generates the tool's
per-machine config from the repository location, guards the embedding
host with a two-second probe, searches and embeds pages itself through
`bin/iirc_embed.py`, updates the vector store after writes, filters
`index.md` from results, and computes suspicion.

## Run it from a checkout

```
claude --plugin-dir /path/to/dokidlc-iirc
```

Outside a session:

```
CLAUDE_PROJECT_DIR=/path/to/repo OLLAMA_HOST=127.0.0.1:11434 bin/iirc search "query"
```

## Search

`hybrid_search()` fuses `semantic_search()` (the active model's vectors,
from `iirc_embed`) with `string_search()` (a local exact-text loop over
name, title, summary, and body, without Sources and links). Ranking: both
paths with a rare term, then semantic by distance, then string-only by
rare-term count with title hits ahead of body hits. In string mode only
the local loop runs.

## Search mode and embedding host

Semantic search is on unless `semantic = false` in the setup file, and
that choice wins over an exported `OLLAMA_HOST`, which only names the
first host to try. The `[embedding]` table of
the setup file names the backend (`ollama`, `openai`, or `onnx`) and the
model; without it the model is nomic through ollama. The wrapper always
points the tool at a closed port (`NO_EMBEDDING_HOST`), because the tool
no longer embeds. In string mode it skips reindexing. An `openai`
backend has one host, the URL setup wrote; `onnx` has none. An ollama
host, when semantic is on, is resolved in this order: `OLLAMA_HOST` in the environment, then
`embedding_host` in `~/.config/dokidlc-iirc/config.toml` (written by
`iirc set-search-backend`; `XDG_CONFIG_HOME` is honoured), then `127.0.0.1:11434`.
`doctor` names the source. `doctor --fix` installs ollama only for a local
host.

## Tests

```
uv run --quiet pytest
claude plugin validate .
claude plugin test .        # hooks/register.test.ts, the drawn rows
```

CI runs both on ubuntu and macos.

## The tool pin

memoryfield-tool is installed from a git commit because its PyPI release
lags main, and with an overrides file that drops `pysqlite3-binary`, which
ships only Linux x86_64 wheels while the tool falls back to stdlib sqlite3.
`iirc doctor --fix` does both. Every command that runs the tool checks its
installed commit against the pin first and refuses a mismatch with the fix
named. To bump: change `tool_rev` in
`iirc.pin`, run `iirc doctor --fix`, run the tests, commit.

## Format and compatibility

The generated half of `.iirc/index.md` carries `iirc format N` and the
plugin commit. `FORMAT` in `bin/iirc` is what the code understands. Older
data is migrated by regenerating the index; newer data is refused with
exit 2. Bump `FORMAT` only with a migration.

`iirc migrate` (`cmd_migrate`, `old_layout`) moves a repository and a
machine from the memory plugin's names. `doctor --brief` prints
`MIGRATION_LINE` while `old_layout()` finds anything, and `register.tsx`
shows it as a red `● iirc: needs migration` under the prompt. Remove both
once no repository uses the old layout.

## Release

Commit to main, let CI pass, then change the `sha` for `iirc` in
`dokidlc-plugins/.claude-plugin/marketplace.json`.

## Hook channels

Only SessionStart and UserPromptSubmit inject plain stdout. SubagentStart,
PostToolUse, PostToolUseFailure, and Stop need
`hookSpecificOutput.additionalContext`; PreCompact has no context channel
at all, so the compaction reminder rides on SessionStart with
`source: compact`. `doctor --brief --hook` reads `hook_event_name` from
stdin to pick the framing; without `--hook` the command never touches
stdin, because a script that inherits an open pipe would otherwise wait
for an EOF that never comes. Host probes are cached in the state dir for ten
minutes so a dead host costs one probe, not one per prompt.

## Tuning files

`iirc tune-suggestions gather-suggestion-data` writes `tune/SESSION.json` in the state dir, one per
session, from the log, the `eval-*.jsonl` candidate rows, the
`prompts/SESSION.jsonl` excerpts, and the transcript when Claude Code
still keeps it. A suggestion line logged before `recall_id` existed joins its
prompt by time, so its prompt can be the wrong one when prompts queue.
`iirc tune-suggestions record-relevance-judgments` appends to `tune/judgments.jsonl`, one file for every
repository, so each line carries its `repo`; the last line for a
repository, session, suggestion line, and page wins. gather-suggestion-data logs a `tune_gather`
row and record-relevance-judgments logs a `tune_judge` row. gather-suggestion-data skips the suggestion lines between a
session's first `tune_gather` row and its last `tune_judge` row, because
those suggestion lines were about tuning. `iirc read --for-tune` logs `tune_read`, not `read`, so
judging does not count as the session's own use of a page. `iirc tune-suggestions mark-session-tuned` logs a `tuned` row whose
`tuned` field names the session, so the row's own `session` stays the
one that tuned. `gate()` is the one gate that both `iirc suggest-pages` and
`iirc tune-suggestions evaluate-suggestion-thresholds` call.

## Approved checks

`write` and `approve-page-check` record the sha256 of a page's check in
`~/.local/state/dokidlc-iirc/checks.json`. `find-suspect-pages` runs only approved
checks and lists the rest; `verify` refuses a page whose check is not
approved or not read-only in form. Only `approve-page-check` and `write` grant
approval, because those are the two places the creator was asked or the
command came from this machine's own agent. The PreToolUse guard asks for
`iirc approve-page-check`, `iirc find-suspect-pages --network`, and `iirc verify --network`,
and the wrapper refuses `--network` off a terminal unless `IIRC_ALLOW_NETWORK=1` is set.
A check whose command contacts a host (`NETWORK_CHECK_RE`) runs only behind that
same consent: `write` approves it unrun, and routine `find-suspect-pages` and
`run-maintenance` give it a glance note instead of running it. The
same guard, registered for Bash and for Read, denies a raw read of a
page file, by `cat`, `head`, `sed`, `tail`, `less`, or `more` in a command
or by the Read tool, and names `iirc read` in the reason, because a page
read raw arrives without its trust markers and the fix commands at its
end. It denies rather than asks because the reason reaches the agent only
on a deny; an ask the creator refuses shows the agent nothing, and a
reviewer subagent on 2026-09-21 retried the cat and then used Read. The
reason ends with the way out when `iirc read` itself is broken:
`iirc doctor --fix`.

The wrapper never writes through a symlink: `regenerate_index` and `init`
refuse one, so a cloned repository cannot point `.iirc/index.md` or
`CLAUDE.md` at another file.

`/iirc demo` draws the `/iirc` card with sample numbers (142 pages, a 74%
hit rate) and reads nothing. Use it for the README screenshot, so the image
shows the design rather than one session's counts.

## Screenshots

`scripts/screenshots.sh [REPO]` captures every image in `docs/UI.md` and the
README into `docs/images/`. It drives Claude Code in REPO (default: the current
directory, which must run this plugin and have pages in `.iirc/`) with
[vhs](https://github.com/charmbracelet/vhs), once in a wide terminal (the reader
docked) and once under 110 columns (the reader above the prompt), and crops each
card to its frame with `scripts/crop-card.py`. The cards and the reader use sample
numbers (`/iirc demo`, `/iirc reader demo`); one real prompt
is sent for the row under a prompt, then interrupted. Needs `brew install vhs`
and uv; it runs as you, logged in. The images are made locally, never in CI:
when the creator says "update the screenshots", run it, look at each image, and
commit the changed ones. `scripts/demo.sh [REPO]` records the demo movie the same way.
