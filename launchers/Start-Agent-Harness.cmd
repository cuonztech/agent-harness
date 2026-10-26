@echo off
rem Doppelklick-Start der Oberflaeche (Windows). Prueft Node und oeffnet den Browser.
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js ist nicht installiert.
  echo Bitte Version 20 oder neuer von https://nodejs.org installieren und diese Datei danach erneut starten.
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0])>=20?0:1)"
if errorlevel 1 (
  echo Die installierte Node.js-Version ist zu alt. Noetig ist Version 20 oder neuer.
  echo Bitte von https://nodejs.org aktualisieren und diese Datei danach erneut starten.
  pause
  exit /b 1
)
if exist "%~dp0..\dist\index.js" (
  node "%~dp0..\dist\index.js" ui %*
) else (
  npx -y cuonztech-agent-harness ui %*
)
if errorlevel 1 pause
