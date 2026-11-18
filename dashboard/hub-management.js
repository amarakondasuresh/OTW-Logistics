/* Hub Management page (Admin Portal).
   Hub records are stored on the server (table `hubs`, API /api/admin/hubs). This file draws the page, keeps a copy
   of the hub list in memory (db.hubs) and talks to the server for every change. It loads before app.js. */

// The 15 Hub Details fields, in the order they appear on the form.
const HUB_FORM = [
  {
    key: "hiName",
    label: "Hub In-Charge Full Name",
    maxlength: 100,
    placeholder: "Full name of the in-charge",
  },
  {
    key: "phone",
    label: "Phone Number",
    type: "tel",
    placeholder: "10-digit mobile, e.g. 9876543210",
  },
  {
    key: "name",
    label: "Hub Name",
    required: true,
    maxlength: 120,
    placeholder: "e.g. AMP_BlackBridge",
  },
  {
    key: "location",
    label: "Hub Location",
    maxlength: 160,
    placeholder: "Area or landmark",
  },
  {
    key: "address",
    label: "Hub Address",
    maxlength: 400,
    placeholder: "Full hub address",
  },
  {
    key: "pincode",
    label: "Hub Pincode",
    inputmode: "numeric",
    maxlength: 6,
    placeholder: "6-digit PIN code",
  },
  {
    key: "city",
    label: "City",
    maxlength: 100,
    placeholder: "e.g. Amalapuram",
  },
  {
    key: "district",
    label: "District",
    maxlength: 100,
    placeholder: "e.g. Konaseema",
  },
  {
    key: "state",
    label: "State",
    required: true,
    maxlength: 100,
    placeholder: "e.g. Andhra Pradesh",
  },
  {
    key: "contactNumber",
    label: "Hub Contact Number",
    type: "tel",
    placeholder: "10-digit mobile",
  },
  {
    key: "email",
    label: "Hub Email ID",
    type: "email",
    maxlength: 254,
    placeholder: "hub@example.com",
  },
  {
    key: "manager",
    label: "Hub Manager Name",
    maxlength: 100,
    placeholder: "Manager full name",
  },
  { key: "openingDate", label: "Hub Opening Date", type: "date" },
  {
    key: "status",
    label: "Hub Status",
    type: "select",
    options: ["Active", "Inactive"],
  },
  {
    key: "url",
    label: "Hub URL",
    type: "url",
    maxlength: 300,
    placeholder: "https://www.example.com",
  },
];
const HUB_MIGRATED_KEY = "owl_hubs_server_v1"; // set once this browser's older hub data has been moved to the server
const HUB_LEGACY_KEY = "owl_hubs_legacy_v1"; // copy of that older data, kept until it has been moved

let hubEditId = null; // id of the hub being edited; null while adding a new hub
let hubEditSnapshot = null; // the values as they were loaded, so only changed fields are sent
let pendingEditId = null; // set by Edit, used by the next draw of the page
let pendingHubImport = null; // an Excel/CSV file that has been checked and is waiting for confirmation

const hubApi = () => PARTNER_API_BASE + "/api/admin/hubs";
const hubCountText = (n) => `${n} hub${n === 1 ? "" : "s"}`;

async function hubRequest(path, { method = "GET", body } = {}) {
  let r;
  try {
    r = await fetch(hubApi() + path, {
      method,
      credentials: "include",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(
      "The server is not reachable. Check that it is running and try again.",
    );
  }
  let out = {};
  try {
    out = await r.json();
  } catch (e) {
    /* empty or non-JSON response */
  }
  if (r.status === 401) {
    sessionEnded();
    throw new Error("Your session has ended. Please sign in again.");
  }
  if (!r.ok) {
    const err = new Error(out.error || `Request failed (${r.status})`);
    err.field = out.field || "";
    err.errors = out.errors || [];
    throw err;
  }
  return out;
}

async function loadHubs({ quiet = false } = {}) {
  if (!currentUser) return false;
  try {
    const out = await hubRequest("");
    db.hubs = Array.isArray(out.hubs) ? out.hubs : [];
    return true;
  } catch (e) {
    if (!quiet) toast("Could not load hubs: " + e.message);
    return false;
  }
}

function replaceHubInCache(hub) {
  const i = db.hubs.findIndex((h) => h.id === hub.id);
  if (i >= 0) db.hubs[i] = hub;
  else db.hubs.push(hub);
}

// ---------- the page ----------
function hubFieldHtml(f) {
  const id = "hf-" + f.key;
  const control =
    f.type === "select"
      ? `<select id="${id}" name="${f.key}">${f.options.map((o) => `<option>${o}</option>`).join("")}</select>`
      : `<input id="${id}" name="${f.key}" type="${f.type || "text"}"${f.required ? " required" : ""}` +
        `${f.maxlength ? ` maxlength="${f.maxlength}"` : ""}${f.inputmode ? ` inputmode="${f.inputmode}"` : ""}` +
        `${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ""} autocomplete="off">`;
  return `<div class="field" data-field="${f.key}"><label for="${id}">${esc(f.label)}${f.required ? ' <span class="req">*</span>' : ""}</label>${control}<small class="field-msg" role="alert"></small></div>`;
}

function hubRows(list = db.hubs) {
  if (!list.length)
    return '<tr><td colspan="7" class="empty">No hubs yet. Add one, or use Import Excel to load a master sheet.</td></tr>';
  return list
    .map(
      (h) =>
        `<tr><td><b>${esc(h.name)}</b></td><td>${esc(h.hiName || "—")}</td><td>${esc(h.city || h.district || "—")}</td><td>${esc(h.state || "—")}</td><td>${esc(h.phone || "—")}</td><td><span class="badge ${h.status === "Active" ? "success" : "danger"}">${esc(h.status || "Active")}</span></td><td><div class="mini-actions"><button class="btn-sm" onclick="editHub('${esc(h.id)}')">Edit</button><button class="btn-sm map-btn" onclick="openHubDirections('${esc(h.id)}')">📍 Directions</button><button class="btn-sm danger" onclick="deleteHub('${esc(h.id)}')">Delete</button></div></td></tr>`,
    )
    .join("");
}

function hubNotesHtml() {
  const items = db.hubs.flatMap((h) => (h.notes || []).map((n) => ({ h, n })));
  const when = (d) => {
    const dt = new Date(d);
    return isNaN(dt) ? d || "" : dt.toLocaleDateString("en-IN");
  };
  return (
    items
      .map(
        ({ h, n }) =>
          `<div class="file-item"><span><b>${esc(h.name)}</b> • ${esc(h.state || "")}<br>${esc(n.text)} • Vacancies: ${esc(n.vacancies)}</span><small>${esc(when(n.date))}</small></div>`,
      )
      .join("") || '<div class="empty">No hub notes.</div>'
  );
}

function hub() {
  return (
    layout(
      "Hub Management",
      "Add a hub with the form below. Use Edit to change a hub.",
      '<label class="ghost file-picker hub-import-btn" title="Import hubs from an .xlsx, .xls or .csv file"><input type="file" id="hubImportFile" accept=".xlsx,.xls,.csv" hidden>📥 Import Excel</label><button class="primary" id="addHub">+ Add New Hub</button>',
    ) +
    '<div id="adminLocationsCard"></div>' +
    `<div class="card hub-form-card">
        <div class="hub-form-head"><h3 id="hubFormTitle">Add New Hub</h3><span class="muted" id="hubFormHint">Fields marked * are required.</span></div>
        <form id="hubPageForm" class="form-grid" autocomplete="off">
          ${HUB_FORM.map(hubFieldHtml).join("")}
          <div class="modal-actions span2"><button type="submit" class="primary" id="hubSaveBtn">Save Hub</button><button type="button" class="ghost" id="clearHubPage">Clear</button></div>
        </form>
      </div>` +
    `<div class="card"><div class="hub-list-toolbar"><div><h3>Hub List</h3><span id="hubResultCount" class="muted">${hubCountText(db.hubs.length)}</span></div><input class="search hub-search" id="hubSearch" placeholder="Search hub, in-charge, city, state, phone..."></div><div class="table-wrap"><table class="table"><thead><tr><th>Hub Name</th><th>In-Charge</th><th>City</th><th>State</th><th>Phone Number</th><th>Status</th><th>Actions</th></tr></thead><tbody id="hubRows">${hubRows(db.hubs)}</tbody></table></div></div>` +
    `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:12px"><h3>Hub Down Notes</h3><button class="primary" id="addNote">+ Add Hub Down Note</button></div><div class="file-list" id="hubNotesList" style="margin-top:12px">${hubNotesHtml()}</div></div>`
  );
}

function hubMapQuery(h) {
  return [h.address, h.location, h.city, h.district, h.state, h.pincode, h.name]
    .filter(Boolean)
    .join(", ");
}

function bindHubs() {
  // Submitted franchise / vendor locations panel (location-management.js) sits above the hub form.
  if (window.mountAdminLocations) window.mountAdminLocations();
  const form = $("#hubPageForm");
  if (!form) return;
  form.onsubmit = submitHubForm;
  // typing in a field clears its error message
  form.addEventListener("input", (e) => {
    const wrap = e.target.closest("[data-field]");
    if (wrap) {
      wrap.classList.remove("has-error");
      wrap.querySelector(".field-msg").textContent = "";
    }
  });
  $("#clearHubPage").onclick = resetHubForm;
  const importInput = $("#hubImportFile");
  if (importInput)
    importInput.onchange = () => {
      const file = importInput.files && importInput.files[0];
      importInput.value = ""; // choosing the same file again still triggers an import
      if (file) importHubFile(file);
    };
  $("#addHub").onclick = () => {
    resetHubForm();
    $("#hf-name").focus();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  $("#addNote").onclick = () => noteModal();
  $("#hubSearch").oninput = applyHubSearch;
  if (pendingEditId) {
    const h = db.hubs.find((x) => x.id === pendingEditId);
    pendingEditId = null;
    if (h) enterHubEdit(h);
    else resetHubForm();
  } else {
    resetHubForm();
  }
  // the list was drawn from memory; refresh it from the server in the background
  loadHubs({ quiet: true }).then((ok) => {
    if (ok && currentPage === "hub") refreshHubList();
  });
}

function applyHubSearch() {
  const q = ($("#hubSearch")?.value || "").trim().toLowerCase();
  const list = q
    ? db.hubs.filter((h) => JSON.stringify(h).toLowerCase().includes(q))
    : db.hubs;
  const body = $("#hubRows");
  if (body) body.innerHTML = hubRows(list);
  const count = $("#hubResultCount");
  if (count)
    count.textContent = q
      ? `${list.length} hub${list.length === 1 ? "" : "s"} found`
      : hubCountText(db.hubs.length);
}

function refreshHubList() {
  applyHubSearch();
  const notes = $("#hubNotesList");
  if (notes) notes.innerHTML = hubNotesHtml();
}

// ---------- the Hub Details form ----------
function readHubForm() {
  const values = {};
  HUB_FORM.forEach((f) => {
    const el = document.getElementById("hf-" + f.key);
    values[f.key] = el ? el.value.replace(/\s+/g, " ").trim() : "";
  });
  return values;
}

function valuesFromHub(h) {
  const values = {};
  HUB_FORM.forEach((f) => {
    values[f.key] =
      f.key === "status" ? h[f.key] || "Active" : (h[f.key] ?? "");
  });
  return values;
}

function fillHubForm(values) {
  HUB_FORM.forEach((f) => {
    const el = document.getElementById("hf-" + f.key);
    if (el) el.value = values[f.key];
  });
}

function clearHubMessages() {
  document.querySelectorAll("#hubPageForm [data-field]").forEach((wrap) => {
    wrap.classList.remove("has-error");
    wrap.querySelector(".field-msg").textContent = "";
  });
}

function setHubFormMode(h) {
  $("#hubFormTitle").textContent = h ? `Edit Hub: ${h.name}` : "Add New Hub";
  $("#hubFormHint").textContent = h
    ? "Change the fields you need and press Update Hub. Only the changed fields are saved."
    : "Fields marked * are required.";
  $("#hubSaveBtn").textContent = h ? "Update Hub" : "Save Hub";
}

function resetHubForm() {
  hubEditId = null;
  hubEditSnapshot = null;
  fillHubForm(
    Object.fromEntries(
      HUB_FORM.map((f) => [f.key, f.key === "status" ? "Active" : ""]),
    ),
  );
  clearHubMessages();
  setHubFormMode(null);
}

function enterHubEdit(h) {
  hubEditId = h.id;
  hubEditSnapshot = valuesFromHub(h);
  fillHubForm(hubEditSnapshot);
  clearHubMessages();
  setHubFormMode(h);
  $("#hf-name").focus();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// Shows server messages under the fields they belong to; a message without a field shows as a notice.
function showHubFormError(err) {
  if (err.field || (err.errors && err.errors.length)) {
    const list =
      err.errors && err.errors.length
        ? err.errors
        : [{ field: err.field, message: err.message }];
    let first = null;
    list.forEach((item) => {
      const wrap = document.querySelector(
        `#hubPageForm [data-field="${item.field}"]`,
      );
      if (!wrap) return;
      wrap.classList.add("has-error");
      wrap.querySelector(".field-msg").textContent = item.message;
      if (!first) first = wrap.querySelector("input,select");
    });
    if (first) first.focus();
  }
  toast(err.message);
}

async function submitHubForm(e) {
  e.preventDefault();
  clearHubMessages();
  const values = readHubForm();
  const btn = $("#hubSaveBtn");
  btn.disabled = true;
  try {
    if (hubEditId) {
      const changes = {};
      HUB_FORM.forEach((f) => {
        if (values[f.key] !== (hubEditSnapshot[f.key] ?? ""))
          changes[f.key] = values[f.key];
      });
      if (!Object.keys(changes).length) {
        toast("No changes to save.");
        return;
      }
      const out = await hubRequest("/" + encodeURIComponent(hubEditId), {
        method: "PATCH",
        body: changes,
      });
      replaceHubInCache(out.hub);
      toast("Hub updated successfully");
    } else {
      const out = await hubRequest("", { method: "POST", body: values });
      replaceHubInCache(out.hub);
      toast("Hub added successfully");
    }
    render("hub");
  } catch (err) {
    showHubFormError(err);
  } finally {
    btn.disabled = false;
  }
}

window.editHub = (id) => {
  pendingEditId = id;
  render("hub");
};

window.deleteHub = async (id) => {
  const h = db.hubs.find((x) => x.id === id);
  if (!confirm(`Delete hub "${h ? h.name : id}"? This cannot be undone.`))
    return;
  try {
    await hubRequest("/" + encodeURIComponent(id), { method: "DELETE" });
    db.hubs = db.hubs.filter((x) => x.id !== id);
    toast("Hub deleted");
    if (hubEditId === id) resetHubForm();
    render("hub");
  } catch (err) {
    toast("Could not delete the hub: " + err.message);
  }
};

window.openHubDirections = (id) => {
  const h = db.hubs.find((x) => x.id === id);
  if (!h) return toast("Hub not found");
  const q = hubMapQuery(h);
  if (!q) return toast("Add the hub location or address first");
  window.open(
    "https://www.google.com/maps/dir/?api=1&destination=" +
      encodeURIComponent(q),
    "_blank",
    "noopener,noreferrer",
  );
};

function noteModal() {
  if (!db.hubs.length) return toast("Add a hub first");
  openModal(
    `<h3>Add Hub Down Note</h3><form id="noteForm" class="form-grid"><div class="field"><label>Hub</label><select id="nHub">${db.hubs.map((h) => `<option value="${esc(h.id)}">${esc(h.name)} — ${esc(h.state || "")}</option>`).join("")}</select></div><div class="field"><label>Vacancies</label><input id="nVac" type="number" min="0" value="0"></div><div class="field span2"><label>Note</label><textarea id="nText" required placeholder="Enter hub down / vacancy note"></textarea></div><div class="modal-actions span2"><button type="button" class="ghost" onclick="closeModal()">Cancel</button><button class="primary">Save Note</button></div></form>`,
  );
  $("#noteForm").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const out = await hubRequest(
        "/" + encodeURIComponent($("#nHub").value) + "/notes",
        {
          method: "POST",
          body: {
            text: $("#nText").value,
            vacancies: Number($("#nVac").value || 0),
          },
        },
      );
      replaceHubInCache(out.hub);
      closeModal();
      render("hub");
      toast("Note saved");
    } catch (err) {
      toast(err.message);
    }
  };
}

// ---------- Import Excel ----------
const chip = (n, label, tone = "") =>
  `<div class="${tone}"><b>${esc(n)}</b><span>${esc(label)}</span></div>`;

async function importHubFile(file) {
  const ext = (
    String(file.name || "")
      .split(".")
      .pop() || ""
  ).toLowerCase();
  if (!["xlsx", "xls", "csv"].includes(ext))
    return toast("Please choose an .xlsx, .xls or .csv file.");
  if (file.size > 5 * 1024 * 1024)
    return toast("This file is larger than 5 MB. Split it into smaller files.");
  let sheets;
  try {
    if (ext === "csv") {
      sheets = [{ name: "", grid: HubExcel.parseCsvGrid(await file.text()) }];
    } else {
      if (!window.XLSX)
        return toast(
          "The Excel reader did not load. Check your internet connection, or save the sheet as CSV and import that.",
        );
      const wb = XLSX.read(await file.arrayBuffer(), {
        type: "array",
        cellDates: true,
      });
      sheets = wb.SheetNames.map((name) => ({
        name,
        grid: XLSX.utils.sheet_to_json(wb.Sheets[name], {
          header: 1,
          raw: true,
          defval: "",
          blankrows: true,
        }),
      }));
    }
  } catch (err) {
    return toast(
      "Could not read this file. Save it again as .xlsx or .csv, then try again.",
    );
  }
  const parsed = HubExcel.hubRowsFromSheets(sheets);
  if (!parsed.details.length)
    return toast(
      "No header row found. The first row must name the columns, for example Hub Name, State, City, Phone Number.",
    );
  if (!parsed.rows.length)
    return toast("No hub rows were found under the header row.");
  try {
    const out = await hubRequest("/import", {
      method: "POST",
      body: {
        fileName: file.name,
        source: "excel",
        dryRun: true,
        rows: parsed.rows,
      },
    });
    pendingHubImport = {
      fileName: file.name,
      rows: parsed.rows,
      report: out.report,
      details: parsed.details,
      skippedSheets: parsed.skippedSheets,
      ignored: [...new Set(parsed.details.flatMap((d) => d.ignored))],
    };
    showImportPreview();
  } catch (err) {
    toast("Could not check the file: " + err.message);
  }
}

const IMPORT_RESULT = {
  new: ["New hub", "success"],
  update: ["Fill blank fields", "success"],
  existing: ["Already in system", "info"],
  duplicate: ["Duplicate in file", "danger"],
  error: ["Not imported", "danger"],
};

function showImportPreview() {
  const p = pendingHubImport;
  const c = p.report.counts;
  const toImport = c.new + c.update;
  const sheetInfo = p.details
    .map(
      (d) =>
        `${d.sheet ? esc(d.sheet) + ": " : ""}header on row ${d.headerRow}, ${d.rows} row${d.rows === 1 ? "" : "s"}`,
    )
    .join(" · ");
  const skipped = p.skippedSheets.length
    ? `<p class="import-note">Sheets without a hub header were skipped: ${p.skippedSheets.map(esc).join(", ")}.</p>`
    : "";
  const ignored = p.ignored.length
    ? `<p class="import-note">Columns not used by Hub Management (ignored): ${p.ignored.map(esc).join(", ")}.</p>`
    : "";
  const duplicateCols = p.details.flatMap((d) => d.duplicated || []);
  const dupNote = duplicateCols.length
    ? `<p class="import-note">Repeated columns (only the first is used): ${duplicateCols.map(esc).join(", ")}.</p>`
    : "";
  openModal(`<h3>Import preview</h3>
    <p class="muted">${esc(p.fileName)} · ${sheetInfo}</p>
    ${skipped}${ignored}${dupNote}
    <div class="import-summary">${chip(p.report.total, "Rows in file")}${chip(toImport, "Records to import", "ok")}${chip(c.update, "Existing hubs to fill in", "ok")}${chip(c.existing, "Already in the system")}${chip(c.duplicate, "Duplicate rows", "warn")}${chip(c.error, "Rows with errors", "bad")}</div>
    <p><b>Records to import: ${toImport}</b>${toImport ? "" : " — nothing new to add."}</p>${c.error ? `<p class="import-note">${c.error} row${c.error === 1 ? " has" : "s have"} errors and will be skipped (listed below).</p>` : ""}
    <div class="table-wrap import-table"><table class="table"><thead><tr><th>Row</th><th>Hub Name</th><th>Result</th><th>Details</th></tr></thead><tbody>${p.report.rows.map(previewRowHtml).join("")}</tbody></table></div>
    <div class="modal-actions"><button class="ghost" type="button" onclick="cancelHubImport()">Cancel</button><button class="primary" id="confirmHubImport" type="button" ${toImport ? "" : "disabled"}>Import ${toImport} record${toImport === 1 ? "" : "s"}</button></div>`);
  const confirmBtn = $("#confirmHubImport");
  if (confirmBtn) confirmBtn.onclick = confirmHubImport;
}

function previewRowHtml(r) {
  const [label, tone] = IMPORT_RESULT[r.status] || [r.status, ""];
  const notes = [
    ...(r.messages || []),
    ...(r.conflicts || []).map(
      (c) =>
        `${c.label}: keeping the saved value "${c.current}" (file has "${c.incoming}")`,
    ),
  ];
  return `<tr><td>${esc(r.label)}</td><td>${esc(r.name || "—")}</td><td><span class="badge ${tone}">${label}</span></td><td>${notes.map(esc).join("<br>") || "—"}</td></tr>`;
}

function cancelHubImport() {
  pendingHubImport = null;
  closeModal();
}

async function confirmHubImport() {
  const p = pendingHubImport;
  if (!p) return;
  const btn = $("#confirmHubImport");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Importing…";
  }
  try {
    const out = await hubRequest("/import", {
      method: "POST",
      body: {
        fileName: p.fileName,
        source: "excel",
        dryRun: false,
        rows: p.rows,
      },
    });
    pendingHubImport = null;
    await loadHubs({ quiet: true });
    render("hub");
    showImportReport(out.report, "Import finished");
  } catch (err) {
    toast("Import was not completed: " + err.message);
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Try again";
    }
  }
}

function importTable(rows, heading) {
  return `<h4>${esc(heading)}</h4><div class="table-wrap import-table"><table class="table"><thead><tr><th>Row</th><th>Hub Name</th><th>Reason</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.label)}</td><td>${esc(r.name || "—")}</td><td>${r.messages.map(esc).join("<br>")}</td></tr>`).join("")}</tbody></table></div>`;
}

function conflictTable(rows) {
  const items = rows.flatMap((r) =>
    r.conflicts.map((c) => ({ hub: r.name, c })),
  );
  return `<h4>Values that were kept as saved</h4><p class="import-note">These fields already had a different value, so they were not changed. Use Edit to change them.</p><div class="table-wrap import-table"><table class="table"><thead><tr><th>Hub</th><th>Field</th><th>Kept (saved)</th><th>Not used (file)</th></tr></thead><tbody>${items.map(({ hub, c }) => `<tr><td>${esc(hub)}</td><td>${esc(c.label)}</td><td>${esc(c.current)}</td><td>${esc(c.incoming)}</td></tr>`).join("")}</tbody></table></div>`;
}

function showImportReport(report, title) {
  const c = report.counts || {};
  const problems = report.rows.filter(
    (r) => r.status === "error" || r.status === "duplicate",
  );
  const conflicts = report.rows.filter(
    (r) => r.conflicts && r.conflicts.length,
  );
  const added = c.new || 0,
    updated = c.update || 0;
  openModal(`<h3>${esc(title || "Import finished")}</h3>
    ${report.fileName ? `<p class="muted">${esc(report.fileName)}</p>` : ""}
    <div class="import-summary">${chip(added, "Hubs added", "ok")}${chip(updated, "Existing hubs filled in", "ok")}${chip(c.existing || 0, "Already in the system")}${chip(c.duplicate || 0, "Duplicate rows", "warn")}${chip(c.error || 0, "Rows not imported", "bad")}</div>
    <p>${added ? `<b>${added}</b> new hub${added === 1 ? "" : "s"} saved. ` : ""}${updated ? `<b>${updated}</b> existing hub${updated === 1 ? "" : "s"} had blank fields filled. ` : ""}${!added && !updated ? "No new information was added. " : ""}The Hub List now shows the saved hubs; use Edit to check any of them.</p>
    ${problems.length ? importTable(problems, "Rows that were not imported") : ""}
    ${conflicts.length ? conflictTable(conflicts) : ""}
    <div class="modal-actions"><button class="primary" type="button" onclick="closeModal()">Close</button></div>`);
}

// ---------- moving hubs saved in this browser to the server (one time) ----------
function legacyHubToRow(h) {
  const id = String(h.id || "");
  return {
    name: h.name || h.code || "",
    hiName: h.hiName || "",
    phone: h.phone || "",
    location: h.location || "",
    address: h.address || "",
    pincode: h.pincode || "",
    city: h.city || "",
    district: h.district || "",
    state: h.state || "",
    contactNumber: "",
    email: h.email || "",
    manager: h.manager || "",
    openingDate: "",
    status: h.status || "Active",
    url: "",
    // older records kept the typed Hub Code as the id
    code: /^XH-\d+$/.test(id) ? h.code || "" : id || h.code || "",
    pod: h.pod || "",
    region: h.region || "",
    contacts: Array.isArray(h.contacts) ? h.contacts : [],
    notes: Array.isArray(h.notes) ? h.notes : [],
  };
}

async function migrateLegacyHubs() {
  if (localStorage.getItem(HUB_MIGRATED_KEY)) return null;
  let legacy = [];
  try {
    legacy = JSON.parse(localStorage.getItem(HUB_LEGACY_KEY) || "[]") || [];
  } catch (e) {
    legacy = [];
  }
  if (!Array.isArray(legacy) || !legacy.length) {
    localStorage.setItem(
      HUB_MIGRATED_KEY,
      JSON.stringify({ at: new Date().toISOString(), rows: 0 }),
    );
    localStorage.removeItem(HUB_LEGACY_KEY);
    return null;
  }
  const rows = legacy.map((h, i) => ({
    ...legacyHubToRow(h),
    rowNumber: i + 1,
  }));
  const out = await hubRequest("/import", {
    method: "POST",
    body: {
      fileName: "Hub data saved in this browser",
      source: "browser",
      dryRun: false,
      rows,
    },
  });
  localStorage.setItem(
    HUB_MIGRATED_KEY,
    JSON.stringify({ at: new Date().toISOString(), rows: rows.length }),
  );
  localStorage.removeItem(HUB_LEGACY_KEY);
  return out.report;
}

// Called after sign-in: loads the hub list from the server, moves any older browser data once, then refreshes the page.
async function initHubs() {
  if (!currentUser) return;
  if (!(await loadHubs())) return;
  try {
    const report = await migrateLegacyHubs();
    if (report) {
      await loadHubs({ quiet: true });
      const needsAttention =
        report.counts.error ||
        report.counts.new ||
        report.counts.update ||
        report.rows.some((r) => r.conflicts && r.conflicts.length);
      if (needsAttention)
        showImportReport(report, "Hub data moved to the server");
    }
  } catch (err) {
    toast(
      "Hub data from this browser will be moved to the server later: " +
        err.message,
    );
  }
  if (currentPage === "dashboard") render("dashboard");
  else if (currentPage === "hub") render("hub");
}
