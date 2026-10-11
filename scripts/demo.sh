#!/bin/sh
# Record the iirc demo movie with vhs into docs/images/iirc-demo.gif.
#
#   scripts/demo.sh [REPO]
#
# REPO runs this plugin and has pages in .iirc/ (default: the current directory).
# One prompt is sent, so recall suggests pages under it, and is interrupted; the
# rest is iirc's own commands, which never call the model. Needs vhs and runs as
# you, logged in. Local only, like scripts/screenshots.sh.
# CLAUDE_CODE_DISABLE_ADVISOR_TOOL keeps the "Advisor Tool (experimental) is on"
# notice off the screen above the prompt.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "${1:-.}" && pwd)
prompt=${IIRC_SHOT_PROMPT:-"why does the recall hook time out when ollama unloads the embed model?"}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
command -v vhs >/dev/null || { echo "demo: vhs is not installed (brew install vhs)" >&2; exit 1; }

cat > "$work/demo.tape" <<EOF
Output demo.gif
Set Shell zsh
Set FontSize 16
Set Width 1600
Set Height 1000
Set TypingSpeed 45ms
Hide
Type "cd $repo && env -u CLAUDE_CODE_CHILD_SESSION IIRC_RECORDING=1 CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1 claude --disallowedTools Bash"
Enter
Sleep 8s
Type "/clear"
Enter
Sleep 2s
Show
Sleep 1s
# a prompt: recall names the pages that match, under it
Type "$prompt"
Sleep 500ms
Enter
Sleep 6s
Escape
Sleep 2s
# unfold the row: each page with its summary and how well it matched (a click on [+] does the same)
Type "/iirc unfold-suggested-pages"
Sleep 500ms
Enter
Sleep 4s
# the short card, then every number
Type "/iirc demo"
Sleep 500ms
Enter
Sleep 4s
Type "/iirc demo status"
Sleep 500ms
Enter
Sleep 5s
# the pane: step through the session's pages, open one, read it, go back, close
Type "/iirc reader demo"
Sleep 500ms
Enter
Sleep 3s
Type "j"
Sleep 800ms
Type "j"
Sleep 800ms
Type "k"
Sleep 800ms
Enter
Sleep 3s
Type "j"
Sleep 1s
Type "j"
Sleep 1s
Type "g"
Sleep 1500ms
Type "h"
Sleep 1500ms
Type "q"
Sleep 2s
Hide
Ctrl+C
Ctrl+C
Sleep 1s
EOF
(cd "$work" && vhs demo.tape >/dev/null)
mkdir -p "$here/docs/images"
cp "$work/demo.gif" "$here/docs/images/iirc-demo.gif"
echo "$here/docs/images/iirc-demo.gif $(du -h "$here/docs/images/iirc-demo.gif" | cut -f1)"
