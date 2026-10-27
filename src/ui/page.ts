// Die Seite der geführten Oberfläche. Ein Dokument, keine Abhängigkeiten.
// Dynamische Texte werden nur über textContent eingesetzt; eingebettet wird allein
// das serverseitig escapte Berichts-HTML (renderHtmlBody).
export const PAGE_HTML = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent-Test</title>
<style>
:root{color-scheme:light dark;--fg:#1f2328;--bg:#fff;--card:#f6f8fa;--line:#d0d7de;--muted:#59636e;--accent:#0969da;--ok:#1a7f37;--bad:#cf222e;--warn:#9a6700}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--bg:#0d1117;--card:#161b22;--line:#30363d;--muted:#9198a1;--accent:#4493f8;--ok:#3fb950;--bad:#f85149;--warn:#d29922}}
*{box-sizing:border-box}
body{margin:0;font:17px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:46rem;margin:0 auto;padding:1.5rem 16px 4rem}
h1{font-size:1.7rem;margin:.2rem 0 .4rem}
h2{font-size:1.25rem;margin:0 0 .6rem}
p{margin:.5rem 0}
.lead{color:var(--muted)}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:1.1rem 1.2rem;margin:1.1rem 0}
section[hidden]{display:none}
.step{font-size:.85rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.warn{border-left:5px solid var(--warn);background:rgba(154,103,0,.12);padding:.7rem .9rem;border-radius:6px;margin:.8rem 0}
button{font:inherit;padding:.65rem 1.1rem;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer;margin:.3rem .4rem .3rem 0}
button.secondary{background:transparent;color:var(--accent)}
button:disabled{opacity:.45;cursor:not-allowed}
input[type=text]{font:inherit;width:100%;padding:.55rem .7rem;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
label{display:block;margin:.7rem 0 .2rem;font-weight:600}
.hint{font-size:.9rem;color:var(--muted)}
ul.checks{list-style:none;padding:0;margin:.6rem 0}
ul.checks li{padding:.35rem 0;border-bottom:1px solid var(--line)}
.ok::before{content:"\\2714  ";color:var(--ok)}
.err::before{content:"\\2718  ";color:var(--bad)}
.fix{margin:.2rem 0 0 1.5rem;color:var(--muted);font-size:.95rem}
pre{white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:.7rem;font-size:.9rem}
code{background:rgba(127,127,127,.15);padding:.1rem .3rem;border-radius:4px}
.cols{display:grid;gap:1rem;grid-template-columns:1fr}
@media (min-width:44rem){.cols{grid-template-columns:1fr 1fr}}
.report h1{font-size:1.2rem}.report h2{font-size:1.1rem}.report h3{font-size:1rem}
.status{font-weight:600}
</style>
</head>
<body>
<main>
<h1>Agent-Test</h1>
<p class="lead">Dieses Programm prüft, ob ein KI-Agent bei einem Fehler sauber reagiert. Zum Beispiel: ob er nach einem Timeout eine Buchung doppelt anlegt. Du brauchst dafür kein Terminal.</p>

<section id="s1">
<div class="step">Schritt 1 von 4</div>
<h2>Bevor es losgeht</h2>
<div class="warn"><strong>Wichtig:</strong> Der Test führt echte Schreibvorgänge aus, zum Beispiel legt er Buchungen an. Verwende nur ein <strong>Testsystem</strong>, niemals echte Kundendaten oder ein Live-System.</div>
<label style="font-weight:400"><input type="checkbox" id="confirm"> Ich teste nur mit einem Testsystem.</label>
<p><button id="go1" disabled>Weiter</button></p>
</section>

<section id="s2" hidden>
<div class="step">Schritt 2 von 4</div>
<h2>Was möchtest du tun?</h2>
<p><button id="pickDemo">Demo ansehen</button> <span class="hint">Ohne eigenen Agenten. Zeigt zwei Beispiel-Agenten und wie ein Ergebnis aussieht.</span></p>
<p><button id="pickOwn" class="secondary">Meinen Agenten prüfen</button> <span class="hint">Du brauchst einen Testserver und einen Agenten, der ihn nutzt.</span></p>
</section>

<section id="sdemo" hidden>
<h2>Demo: zwei Beispiel-Agenten</h2>
<p class="hint">Das sind zwei fest eingebaute Beispiel-Agenten, nicht dein Agent. Beide bekommen denselben Fehler: Der Schreibvorgang klappt, der Agent sieht aber nur einen Timeout.</p>
<p id="demoWait">Wird berechnet …</p>
<div class="cols">
<div><h3>Vorsichtiger Agent</h3><div class="report" id="demoCareful"></div></div>
<div><h3>Unvorsichtiger Agent</h3><div class="report" id="demoNaive"></div></div>
</div>
<p><button id="demoBack" class="secondary">Zurück</button></p>
</section>

<section id="s3" hidden>
<div class="step">Schritt 3 von 4</div>
<h2>Testserver angeben und prüfen</h2>
<p>Wie wird dein Testserver gestartet? Die meisten Server starten mit <code>node</code> und einer Datei.</p>
<label for="cmd">Programm</label>
<input type="text" id="cmd" value="node">
<label for="file">Start-Datei deines Servers</label>
<input type="text" id="file" placeholder="z. B. C:\\projekte\\mein-server\\dist\\server.js">
<p class="hint">Der vollständige Pfad zur Datei. Leerzeichen im Pfad sind in Ordnung.</p>
<label for="extra">Weitere Argumente (nur wenn nötig)</label>
<input type="text" id="extra" placeholder="meist leer">
<label for="writeTools">Tools, die schreiben (nur wenn die Prüfung Tools nicht einordnen kann)</label>
<input type="text" id="writeTools" placeholder="meist leer, sonst z. B. buche_*, lege_an_*">
<label for="readTools">Tools, die nur lesen (nur wenn nötig)</label>
<input type="text" id="readTools" placeholder="meist leer, sonst z. B. zeige_*">
<p class="hint">Mehrere Namen mit Komma trennen; * steht für beliebigen Text. Gibst du Schreib-Tools an, ersetzt das die eingebaute Namensliste.</p>
<p><button id="useBundled" class="secondary" hidden>Mitgeliefertes Testsystem verwenden</button></p>
<p><button id="check">Prüfen</button></p>
<ul class="checks" id="checks"></ul>
<div id="tools" class="hint"></div>
<p><button id="go3" hidden>Weiter</button> <button id="back3" class="secondary">Zurück</button></p>
</section>

<section id="s4" hidden>
<div class="step">Schritt 4 von 4</div>
<h2>Agent anschließen</h2>
<p>Trage den Test in dein Agenten-Programm ein. Dein Agent startet den Harness dann selbst. Danach gib ihm eine Aufgabe, bei der etwas geschrieben wird, zum Beispiel: <em>„Lege eine Buchung für Muster AG am 3. November über 250 CHF an.“</em></p>
<label>Claude Code (ein Befehl im Terminal)</label>
<pre id="cfgCode"></pre>
<p><button id="copyCode" class="secondary">Kopieren</button></p>
<label>Claude Desktop oder andere Programme (Konfigurationsdatei)</label>
<pre id="cfgJson"></pre>
<p><button id="copyJson" class="secondary">Kopieren</button></p>
<p class="hint">Der Bericht wird hier gespeichert: <code id="reportPath"></code></p>
<p class="status" id="status">Warte auf den Agenten …</p>
<div class="report" id="result"></div>
<p><a id="dl" href="#" hidden>Bericht als Datei speichern</a></p>
</section>
</main>
<script>
(function () {
  var TOKEN = "__TOKEN__";
  function $(id) { return document.getElementById(id); }
  function show(id) { ["s1","s2","sdemo","s3","s4"].forEach(function (s) { $(s).hidden = (s !== id); }); window.scrollTo(0, 0); }
  function api(path, body) {
    var opts = { headers: { "x-harness-token": TOKEN } };
    if (body !== undefined) { opts.method = "POST"; opts.headers["content-type"] = "application/json"; opts.body = JSON.stringify(body); }
    return fetch(path, opts).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || "Fehler"); return j; }); });
  }
  function copy(text, btn) {
    var done = function () { var t = btn.textContent; btn.textContent = "Kopiert"; setTimeout(function () { btn.textContent = t; }, 1500); };
    if (navigator.clipboard) { navigator.clipboard.writeText(text).then(done, function () {}); }
  }

  $("confirm").addEventListener("change", function () { $("go1").disabled = !$("confirm").checked; });
  $("go1").addEventListener("click", function () { show("s2"); });

  // --- Demo
  $("pickDemo").addEventListener("click", function () {
    show("sdemo"); $("demoWait").hidden = false;
    api("/api/demo", {}).then(function (d) {
      $("demoCareful").innerHTML = d.careful; $("demoNaive").innerHTML = d.naive; $("demoWait").hidden = true;
    }).catch(function (e) { $("demoWait").textContent = "Fehler: " + e.message; });
  });
  $("demoBack").addEventListener("click", function () { show("s2"); });

  // --- Eigener Agent
  var bundled = null, ready = null, timer = null;
  api("/api/info").then(function (info) { bundled = info.bundledTestsystem; if (bundled) { $("useBundled").hidden = false; } });
  $("pickOwn").addEventListener("click", function () { show("s3"); });
  $("back3").addEventListener("click", function () { show("s2"); });
  $("useBundled").addEventListener("click", function () { $("cmd").value = "node"; $("file").value = bundled; $("extra").value = ""; });

  function unquote(text) {
    var t = text.trim();
    if (t.length > 1 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) { t = t.slice(1, -1); }
    return t;
  }
  function currentArgs() {
    var file = unquote($("file").value);
    return (file ? [file] : []).concat(splitArgs($("extra").value.trim()));
  }

  function splitArgs(text) {
    // Pfade mit Leerzeichen in Anführungszeichen; sonst an Leerzeichen trennen.
    var out = [], cur = "", q = null;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) { if (c === q) { q = null; } else { cur += c; } }
      else if (c === '"' || c === "'") { q = c; }
      else if (c === " ") { if (cur) { out.push(cur); cur = ""; } }
      else { cur += c; }
    }
    if (cur) out.push(cur);
    return out;
  }

  $("check").addEventListener("click", function () {
    var list = $("checks"); list.textContent = ""; $("tools").textContent = ""; $("go3").hidden = true; ready = null;
    var args = currentArgs();
    $("check").disabled = true;
    var toolFields = { writeTools: $("writeTools").value.trim(), readTools: $("readTools").value.trim() };
    api("/api/doctor", Object.assign({ command: $("cmd").value.trim(), args: args }, toolFields)).then(function (r) {
      r.checks.forEach(function (c) {
        var li = document.createElement("li"); li.className = c.ok ? "ok" : "err";
        li.appendChild(document.createTextNode(c.label));
        if (!c.ok && (c.fix || c.detail)) { var d = document.createElement("div"); d.className = "fix"; d.textContent = (c.detail ? c.detail + " " : "") + (c.fix ? "\\u2192 " + c.fix : ""); li.appendChild(d); }
        list.appendChild(li);
      });
      if (r.toolLines.length) { $("tools").textContent = "Erkannte Tools: " + r.toolLines.map(function (t) { return t.trim().replace(/\\s+/g, " "); }).join("; "); }
      if (r.ok) { ready = Object.assign({ command: $("cmd").value.trim(), args: args }, toolFields); $("go3").hidden = false; }
    }).catch(function (e) { var li = document.createElement("li"); li.className = "err"; li.textContent = e.message; list.appendChild(li); })
      .then(function () { $("check").disabled = false; });
  });

  $("go3").addEventListener("click", function () {
    api("/api/config", Object.assign({ confirmedTestsystem: $("confirm").checked }, ready)).then(function (cfg) {
      $("cfgCode").textContent = cfg.claudeCode; $("cfgJson").textContent = cfg.claudeDesktop; $("reportPath").textContent = cfg.reportFile;
      $("copyCode").onclick = function () { copy(cfg.claudeCode, $("copyCode")); };
      $("copyJson").onclick = function () { copy(cfg.claudeDesktop, $("copyJson")); };
      show("s4"); poll();
    }).catch(function (e) { alert(e.message); });
  });

  function poll() {
    if (timer) clearInterval(timer);
    var tick = function () {
      api("/api/status").then(function (s) {
        if (s.state === "waiting") { $("status").textContent = "Warte auf den Agenten …"; }
        else if (s.state === "connected") { $("status").textContent = "Der Agent ist verbunden. Warte auf den ersten Schreibvorgang …"; }
        else {
          $("status").textContent = "Zwischenstand, wird bei jedem weiteren Aufruf aktualisiert:";
          $("result").innerHTML = s.body; $("dl").hidden = false; $("dl").href = "/api/report.html?t=" + encodeURIComponent(TOKEN);
        }
      }).catch(function () {});
    };
    tick(); timer = setInterval(tick, 2000);
  }
})();
</script>
</body>
</html>
`;
