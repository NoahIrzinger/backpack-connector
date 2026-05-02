/**
 * backpack-connector viewer extension — Graph Query panel.
 * Queries ArcadeDB directly (fetch to localhost:2480, CORS allowed for local dev).
 */

const DEFAULT_URL = "http://localhost:2480";
const DEFAULT_USER = "root";
const DEFAULT_PASS = "arcadedb";

function deriveDatabase(graphName) {
  return (graphName || "").replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
}

function basicAuth(user, pass) {
  return "Basic " + btoa(user + ":" + pass);
}

async function arcadeQuery(apiFetch, url, user, pass, database, language, query) {
  const endpoint = `${url}/api/v1/command/${encodeURIComponent(database)}`;
  const res = await apiFetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": basicAuth(user, pass),
    },
    body: JSON.stringify({ language, command: query }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body.detail || body.error || `HTTP ${res.status}`);
  }
  return body.result || [];
}

export async function activate(api) {
  const apiFetch = api.fetch.bind(api);
  let cfg = {
    url: (await api.settings.get("url")) ?? DEFAULT_URL,
    user: (await api.settings.get("user")) ?? DEFAULT_USER,
    pass: (await api.settings.get("pass")) ?? DEFAULT_PASS,
  };

  // --- Build panel DOM ---

  const root = document.createElement("div");
  root.className = "cq-root";

  // Settings section (hidden by default)
  const settingsSection = document.createElement("div");
  settingsSection.className = "cq-section";
  settingsSection.hidden = true;

  const urlField = makeField("URL", "text", cfg.url);
  const userField = makeField("Username", "text", cfg.user);
  const passField = makeField("Password", "password", cfg.pass);
  const saveBtn = makeBtn("Save", false);
  saveBtn.classList.add("cq-btn-primary");

  settingsSection.append(urlField.row, userField.row, passField.row, makeActions([saveBtn]));

  saveBtn.addEventListener("click", async () => {
    cfg = { url: urlField.input.value.trim(), user: userField.input.value.trim(), pass: passField.input.value };
    await api.settings.set("url", cfg.url);
    await api.settings.set("user", cfg.user);
    await api.settings.set("pass", cfg.pass);
    settingsSection.hidden = true;
    querySection.hidden = false;
  });

  // Query section
  const querySection = document.createElement("div");

  const queryFields = document.createElement("div");
  queryFields.className = "cq-section";

  const dbField = makeField("Database", "text", deriveDatabase(api.getGraphName()));
  dbField.input.placeholder = "e.g. ms_teams_meeting_bot";
  dbField.input.dataset.cq = "database";

  const langRow = makeLangRow();
  queryFields.append(dbField.row, langRow);

  const textareaWrap = document.createElement("div");
  textareaWrap.className = "cq-textarea-wrap";
  const textarea = document.createElement("textarea");
  textarea.className = "cq-textarea";
  textarea.rows = 4;
  textarea.placeholder = "MATCH (n:Platform)-[r]->(a:API)\nRETURN n.name, type(r), a.name LIMIT 20";
  textareaWrap.appendChild(textarea);

  const execBtn = makeBtn("Execute", false);
  execBtn.classList.add("cq-btn-primary");
  const clearBtn = makeBtn("Clear", false);

  clearBtn.addEventListener("click", () => {
    textarea.value = "";
    textarea.focus();
    clearResults();
  });

  const actions = makeActions([execBtn, clearBtn]);

  querySection.append(queryFields, textareaWrap, actions);

  // Results section
  const divider = document.createElement("hr");
  divider.className = "cq-divider";

  const resultsSection = document.createElement("div");
  resultsSection.className = "cq-results";
  resultsSection.hidden = true;

  const resultsHeader = document.createElement("div");
  resultsHeader.className = "cq-results-header";

  const resultCount = document.createElement("span");
  const focusBtn = makeBtn("Focus in viewer", false);
  focusBtn.classList.add("cq-focus-btn");
  focusBtn.hidden = true;

  resultsHeader.append(resultCount, focusBtn);

  const resultsBody = document.createElement("div");
  resultsBody.className = "cq-results-body";

  resultsSection.append(resultsHeader, resultsBody);

  root.append(settingsSection, querySection, divider, resultsSection);

  // --- Execute logic ---

  let lastBkIds = [];

  execBtn.addEventListener("click", async () => {
    const db = dbField.input.value.trim();
    const lang = langRow.getValue();
    const q = textarea.value.trim();
    if (!db || !q) return;

    clearResults();
    showSpinner();
    execBtn.disabled = true;

    try {
      const rows = await arcadeQuery(apiFetch, cfg.url, cfg.user, cfg.pass, db, lang, q);
      execBtn.disabled = false;
      renderResults(rows);
    } catch (err) {
      execBtn.disabled = false;
      showError(err.message);
    }
  });

  textarea.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      execBtn.click();
    }
  });

  focusBtn.addEventListener("click", () => {
    if (lastBkIds.length > 0) {
      api.focusNodes(lastBkIds, 2);
    }
  });

  // Auto-fill database when graph switches
  api.on("graph-switched", () => {
    const derived = deriveDatabase(api.getGraphName());
    if (derived) dbField.input.value = derived;
    clearResults();
  });

  // --- Results rendering ---

  function clearResults() {
    resultsSection.hidden = true;
    resultsBody.innerHTML = "";
    lastBkIds = [];
    focusBtn.hidden = true;
  }

  function showSpinner() {
    resultsSection.hidden = false;
    resultCount.textContent = "Running…";
    resultsBody.innerHTML = "";
  }

  function showError(msg) {
    resultsSection.hidden = false;
    resultCount.textContent = "Error";
    const err = document.createElement("div");
    err.className = "cq-error";
    err.textContent = msg;
    resultsBody.appendChild(err);
  }

  function renderResults(rows) {
    resultsSection.hidden = false;

    if (!rows || rows.length === 0) {
      resultCount.textContent = "0 results";
      const empty = document.createElement("div");
      empty.className = "cq-empty";
      empty.textContent = "No results";
      resultsBody.appendChild(empty);
      return;
    }

    // Flatten each row: unwrap nested objects (Cypher RETURN n wraps node in {n: {...}})
    const flat = rows.map(flattenRow);

    // Collect bk_ids for "Focus in viewer"
    lastBkIds = flat.flatMap((r) => {
      const id = r.bk_id;
      return typeof id === "string" && id ? [id] : [];
    });

    resultCount.textContent = `${rows.length} result${rows.length === 1 ? "" : "s"}`;
    focusBtn.hidden = lastBkIds.length === 0;

    // Build table
    const cols = collectColumns(flat);
    if (cols.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cq-empty";
      empty.textContent = JSON.stringify(rows[0]);
      resultsBody.appendChild(empty);
      return;
    }

    const table = document.createElement("table");
    table.className = "cq-table";

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    for (const col of cols) {
      const th = document.createElement("th");
      th.textContent = col;
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);

    const tbody = document.createElement("tbody");
    for (const row of flat) {
      const tr = document.createElement("tr");
      for (const col of cols) {
        const td = document.createElement("td");
        const val = row[col];
        td.textContent = val === null || val === undefined ? "" : String(val);
        td.title = td.textContent;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }

    table.append(thead, tbody);
    resultsBody.appendChild(table);
  }

  function flattenRow(row) {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        // Unwrap nested node objects (Cypher returns them wrapped)
        for (const [kk, vv] of Object.entries(v)) {
          if (!kk.startsWith("@") && !kk.startsWith("_")) out[kk] = vv;
        }
      } else if (!k.startsWith("@") && !k.startsWith("_")) {
        out[k] = v;
      }
    }
    return out;
  }

  function collectColumns(rows) {
    const seen = new Set();
    const cols = [];
    for (const row of rows) {
      for (const k of Object.keys(row)) {
        if (!seen.has(k)) { seen.add(k); cols.push(k); }
      }
    }
    // Prioritize human-readable columns first
    const priority = ["name", "label", "title", "type", "bk_graph"];
    return [
      ...priority.filter((c) => seen.has(c)),
      ...cols.filter((c) => !priority.includes(c) && !c.startsWith("bk_")),
      ...cols.filter((c) => c.startsWith("bk_") && seen.has(c)),
    ];
  }

  // --- Mount panel ---

  let panel = null;

  api.registerTaskbarIcon({
    label: "Query",
    iconText: "⟨⟩",
    position: "bottom-right",
    onClick() {
      if (!panel) {
        panel = api.mountPanel(root, {
          title: "Graph Query",
          defaultPosition: { left: 180, top: 80 },
          headerButtons: [{
            label: "Settings",
            iconText: "⚙",
            onClick() {
              const showSettings = settingsSection.hidden;
              settingsSection.hidden = !showSettings;
              querySection.hidden = showSettings;
              // Sync inputs from current config
              if (!settingsSection.hidden) {
                urlField.input.value = cfg.url;
                userField.input.value = cfg.user;
                passField.input.value = cfg.pass;
              }
            },
          }],
          onClose() { panel = null; },
        });
      } else if (panel.isVisible()) {
        panel.setVisible(false);
      } else {
        panel.setVisible(true);
        panel.bringToFront();
      }
    },
  });

  // --- Helpers ---

  function makeField(label, type, value) {
    const row = document.createElement("div");
    row.className = "cq-field";
    const lbl = document.createElement("label");
    lbl.className = "cq-label";
    lbl.textContent = label;
    const input = document.createElement("input");
    input.type = type;
    input.className = "cq-input";
    input.value = value;
    row.append(lbl, input);
    return { row, input };
  }

  function makeBtn(text, primary) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = primary ? "cq-btn cq-btn-primary" : "cq-btn";
    btn.textContent = text;
    return btn;
  }

  function makeActions(btns) {
    const div = document.createElement("div");
    div.className = "cq-actions";
    for (const b of btns) div.appendChild(b);
    return div;
  }

  function makeLangRow() {
    const row = document.createElement("div");
    row.className = "cq-field";
    const lbl = document.createElement("label");
    lbl.className = "cq-label";
    lbl.textContent = "Language";
    const radios = document.createElement("div");
    radios.className = "cq-radio-row";

    let selected = "opencypher";

    for (const [value, label] of [["opencypher", "Cypher"], ["sql", "SQL"]]) {
      const l = document.createElement("label");
      l.className = "cq-radio-label";
      const r = document.createElement("input");
      r.type = "radio";
      r.name = "cq-lang-" + Math.random().toString(36).slice(2);
      r.value = value;
      r.checked = value === "opencypher";
      r.addEventListener("change", () => { if (r.checked) selected = value; });
      l.append(r, label);
      radios.appendChild(l);
    }

    row.append(lbl, radios);
    return Object.assign(row, { getValue() { return selected; } });
  }
}
