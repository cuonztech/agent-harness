#!/bin/sh
# Start der Oberflaeche (macOS und Linux). Prueft Node und oeffnet den Browser.
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js ist nicht installiert."
  echo "Bitte Version 20 oder neuer von https://nodejs.org installieren und das Skript danach erneut starten."
  exit 1
fi
if ! node -e "process.exit(Number(process.versions.node.split('.')[0])>=20?0:1)"; then
  echo "Die installierte Node.js-Version ist zu alt. Noetig ist Version 20 oder neuer."
  echo "Hinweis: 'apt install nodejs' liefert unter Ubuntu 24.04 nur Node 18. Bitte von https://nodejs.org installieren."
  exit 1
fi
here="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$here/../dist/index.js" ]; then
  exec node "$here/../dist/index.js" ui "$@"
else
  exec npx -y cuonztech-agent-harness ui "$@"
fi
