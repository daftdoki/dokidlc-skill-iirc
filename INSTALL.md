# Installing iirc by hand

The agent can do all of this for you. Say "set up iirc" in a session and
it holds a short conversation, then runs the commands. This document is for
the case where you want to run them yourself, or where you are writing a
bootstrap script for a new agent repository.

## Where to run the commands

Every command needs a repository, including the per-machine ones. `main()`
calls `set_root(project_root())` before it dispatches any subcommand, and
`project_root()` stops with "not inside a git repository and
CLAUDE_PROJECT_DIR is unset". So run `git init` on the target repository
first if it is new, then run everything below from inside it. Both of
these work:

- A Claude Code session opened in the target repository. The plugin puts
  `iirc` on PATH while it is enabled.
- A terminal with the working directory inside the target repository. The
  command is at
  `~/.claude/plugins/cache/dokidlc/iirc/<commit>/bin/iirc`.

## Per machine, once

### 1. Check the prerequisites

Claude Code 2.1.195 or later, `uv` on PATH, and git. `iirc doctor` exits
1 at the first check without `uv`.

### 2. Add the marketplace and install the plugin

```sh
claude plugin marketplace add git@github.com:daftdoki/dokidlc-plugins.git
claude plugin install iirc@dokidlc
```

Use the full `git@` URL, not the `daftdoki/dokidlc-plugins` shorthand.
The shorthand clones over SSH and fails with
"No ED25519 host key is known for github.com" on a machine with no
`known_hosts` file, which is the normal state of a fresh container. The
shorthand is fine on a machine that already has github.com in
`known_hosts`.

### 3. Choose the search mode

```sh
iirc set-search-backend --local                      # ollama on this machine
iirc set-search-backend --host http://frame:11434    # ollama on another host
iirc set-search-backend --openai https://llm.example.net   # an OpenAI-compatible host
iirc set-search-backend --cpu                        # all-MiniLM-L6-v2 on this CPU, no ollama
iirc set-search-backend --substring                  # string search only
```

With ollama, the model is `qwen3-embedding:0.6b` unless `--model` names
`nomic-embed-text` or `embeddinggemma`. `--cpu` fetches about 90 MB of
model files from a pinned commit, checks their sha256, and runs the
model once, so onnxruntime installs now and not in a hook.

Pass a flag. `cmd_setup` in `bin/iirc` calls `sys.stdin.isatty()` and
stops with "not a terminal" when it gets neither flags nor a tty. The
Claude Code Bash tool gives it no tty, so the interactive prompts only
work from a real terminal. The answer goes to
`~/.config/dokidlc-iirc/config.toml`.

### 4. Install the dependencies

```sh
iirc doctor --fix
```

This installs memoryfield-tool from the commit in `iirc.pin`, with an
overrides file that drops `pysqlite3-binary`. That package ships a Linux
x86_64 wheel only, and the tool falls back to stdlib sqlite3 without it.
See `install_tool()` in `bin/iirc`. On macOS, when the embedding host is
local and does not answer, `--fix` also runs `brew install ollama` and
`brew services start ollama`, then pulls the model setup chose. On Linux
it prints the one ollama command to run.

Doctor exits 1 here, and that is expected. The repository has no `.iirc/`
yet, so the field, CLAUDE.md, and persistence rows report FAIL. Only four
rows must read `ok` at this point: `uv on PATH`, `memoryfield-tool`, and
the search rows for the choice in step 3: `embedding host` and `model`
for ollama, `embedding endpoint` for an OpenAI-compatible host, or the
model files for the CPU. The rest turn green at step 9.

## Per repository

### 5. Make it a git repository

Run `git init` if it is new, and add a `.gitignore`. Ignore Python caches
and editor clutter. Do not ignore `.iirc/`. `git_checks()` reports an
ignored `.iirc/` as a persistence failure.

### 6. Create the field

```sh
iirc init
```

This creates `.iirc/index.md` from the template, appends the
`## IIRC <!-- iirc -->` section to `CLAUDE.md`, writes
`.claude/settings.json` (step 7) when it does not exist, and runs
`git add` on all three. Do not edit inside that marked section. `cmd_init` rewrites it
whenever the plugin's text moves on. `index.md` is yours to edit; iirc
keeps only its last line, `<!-- iirc format 1 -->`.

### 7. Declare the plugin in project settings

`iirc init` writes this `.claude/settings.json` when the file does not
exist. When it exists, add these keys by hand:

```json
{
  "extraKnownMarketplaces": {
    "dokidlc": { "source": { "source": "github", "repo": "daftdoki/dokidlc-plugins" } }
  },
  "enabledPlugins": { "iirc@dokidlc": true }
}
```

`claude plugin install iirc@dokidlc -s project` writes only
`enabledPlugins`. It leaves out `extraKnownMarketplaces` when this machine
already knows the marketplace, and then the file resolves nowhere on a
clone.

### 8. Commit the three paths

```sh
git add .iirc .claude/settings.json CLAUDE.md && git commit
```

These three are the `PERSISTED` tuple in `bin/iirc`. Doctor checks that
each one is tracked. The pages survive a clone only if they are committed.

### 9. Confirm

```sh
iirc doctor
```

Every row should read `ok`, including "field validates". The last line
names the index cache directory, which holds one vector store per store
and model. That cache is derived, never committed, and `iirc rebuild-search-index`
rebuilds it.

## What project settings do not do

Settings declare intent. They install nothing. Someone who clones the new
repository on another machine still needs steps 1 to 4 before `iirc` is
on PATH. Put those commands in the repository's own bootstrap script if the
agent runs in a container.
