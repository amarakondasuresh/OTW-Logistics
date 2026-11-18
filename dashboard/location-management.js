// Admin Portal > Hub Management > Submitted Locations.
// Franchise and vendor submissions appear here automatically. Admin can approve (the location becomes an active hub),
// reject, edit, open Directions in Google Maps, or delete. Everything is saved on the server; the list refreshes
// every 30 seconds while the Hub page is open. Only signed-in admins can reach these routes.

const LOC_STATUS = {
  PENDING: "Pending Approval",
  ACTIVE: "Active",
  REJECTED: "Rejected",
};
// Official State / Union Territory names (same list as the partner Add Location form). The server checks it again.
const LOC_STATES = ["Andaman and Nicobar Islands", "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chandigarh", "Chhattisgarh", "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jammu and Kashmir", "Jharkhand", "Karnataka", "Kerala", "Ladakh", "Lakshadweep", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Puducherry", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal"];
const LOC_EDIT_FIELDS = [
  { key: "name", label: "Location Name", max: 120 },
  { key: "state", label: "State", select: LOC_STATES },
  { key: "city", label: "City / Town", max: 80 },
  { key: "district", label: "District", max: 80 },
  { key: "area", label: "Area", max: 120 },
  { key: "pin", label: "PIN Code", max: 6 },
  { key: "url", label: "Location URL (optional)", max: 500, optional: true },
];
let adminLocations = [];
let adminLocationCounts = { pending: 0, active: 0, rejected: 0, total: 0 };
let adminLocationsUpdated = null;
let adminLocationsBusy = new Set(); // ids with a request in flight; blocks repeated clicks
let adminLocationsLoading = false;

const locApiBase = () => PARTNER_API_BASE + "/api/admin/locations";

async function locRequest(path = "", { method = "GET", body } = {}) {
  let r;
  try {
    r = await fetch(locApiBase() + path, {
      method,
      credentials: "include",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error("The server is not reachable. Check that it is running and try again.");
  }
  let out = {};
  try {
    out = await r.json();
  } catch (e) {
    /* empty response */
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

const locStatusBadge = (s) => {
  if (s === LOC_STATUS.ACTIVE) return `<span class="badge success">${esc(s)}</span>`;
  if (s === LOC_STATUS.REJECTED) return `<span class="badge danger">${esc(s)}</span>`;
  return `<span class="badge" style="background:#fff4d8;color:#986b00">${esc(s)}</span>`;
};

// Clickable only for web links; the admin can change or clear it in Edit.
const locMapLink = (url) =>
  /^https?:\/\//i.test(url || "")
    ? `<br><a class="location-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open map ↗</a>`
    : "";

const locDate = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

// Google Maps directions to the saved address (name, area, city, district and PIN).
function locDirectionsUrl(l) {
  const place = [l.name, l.area, l.city, l.district, l.pin, "India"]
    .filter(Boolean)
    .join(", ");
  return "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(place);
}

function locActionButtons(l) {
  const id = esc(l.id);
  const btn = (label, action, cls = "btn-sm") =>
    `<button type="button" class="${cls}" data-loc-action="${action}" data-id="${id}"${adminLocationsBusy.has(l.id) ? " disabled" : ""}>${label}</button>`;
  const parts = [];
  if (l.status !== LOC_STATUS.ACTIVE) parts.push(btn("Approve", "approve"));
  if (l.status === LOC_STATUS.PENDING) parts.push(btn("Reject", "reject"));
  if (l.status === LOC_STATUS.ACTIVE) parts.push(btn("📍 Direction", "direction", "btn-sm map-btn"));
  parts.push(btn("Edit", "edit"));
  parts.push(btn("Delete", "delete", "btn-sm danger"));
  return `<div class="mini-actions">${parts.join("")}</div>`;
}

function filteredLocations() {
  const status = document.getElementById("locStatusFilter")?.value || "";
  const q = (document.getElementById("locSearch")?.value || "").trim().toLowerCase();
  return adminLocations.filter(
    (l) =>
      (!status || l.status === status) &&
      (!q ||
        [l.id, l.name, l.city, l.district, l.area, l.pin, l.appliedBy, l.status]
          .join(" ")
          .toLowerCase()
          .includes(q)),
  );
}

// For an approved location: shows the hub it created in Hub List and that hub's status.
const locHubNote = (l) =>
  l.status === LOC_STATUS.ACTIVE && l.hub
    ? `<br><small class="muted">In Hub List: ${esc(l.hub.name)} • ${esc(l.hub.status)}</small>`
    : "";

function renderLocRows() {
  const body = document.getElementById("locRows");
  if (!body) return;
  const rows = filteredLocations();
  body.innerHTML = rows.length
    ? rows
        .map(
          (l) =>
            `<tr><td><b>${esc(l.id)}</b></td><td>${esc(l.name)}${locMapLink(l.url)}</td><td>${esc(l.city)}</td><td>${esc(l.district)}</td><td>${esc(l.area)}</td><td>${esc(l.pin)}</td><td>${esc(l.appliedBy)}<br><small class="muted">${esc(l.appliedRole === "franchise" ? "Franchise" : "Vendor")} • ${esc(locDate(l.createdAt))}</small></td><td>${locStatusBadge(l.status)}${l.status === LOC_STATUS.REJECTED && l.rejectReason ? `<br><small class="muted">${esc(l.rejectReason)}</small>` : ""}${locHubNote(l)}</td><td>${locActionButtons(l)}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="9" class="empty">${
        adminLocations.length
          ? "No locations match the filter."
          : "No locations have been submitted yet. Franchise and vendor locations appear here automatically."
      }</td></tr>`;
  const c = adminLocationCounts;
  const summary = document.getElementById("locSummary");
  if (summary)
    summary.textContent = `${c.pending} pending • ${c.active} active • ${c.rejected} rejected`;
  const updated = document.getElementById("locUpdated");
  if (updated && adminLocationsUpdated)
    updated.textContent =
      "Updated " +
      adminLocationsUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) +
      " • refreshes every 30 seconds";
}

// Draws the card into the Hub Management page. Called by bindHubs() after the page is drawn.
function mountAdminLocations() {
  const mount = document.getElementById("adminLocationsCard");
  if (!mount) return;
  mount.innerHTML = `
    <div class="card">
      <div class="hub-list-toolbar">
        <div><h3>Submitted Locations</h3><span id="locSummary" class="muted"></span></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <select id="locStatusFilter" aria-label="Filter by status">
            <option value="">All statuses</option>
            <option value="${LOC_STATUS.PENDING}">Pending Approval</option>
            <option value="${LOC_STATUS.ACTIVE}">Active</option>
            <option value="${LOC_STATUS.REJECTED}">Rejected</option>
          </select>
          <input class="search hub-search" id="locSearch" placeholder="Search ID, name, city, PIN, applied by...">
          <button class="ghost" type="button" id="locRefresh">⟳ Refresh</button>
        </div>
      </div>
      <p class="muted" id="locUpdated" style="margin:6px 0 10px"></p>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Location ID</th><th>Location Name</th><th>City / Town</th><th>District</th><th>Area</th>
              <th>PIN Code</th><th>Applied By</th><th>Status</th><th>Actions</th>
            </tr>
          </thead>
          <tbody id="locRows"><tr><td colspan="9" class="empty">Loading submitted locations…</td></tr></tbody>
        </table>
      </div>
    </div>`;
  document.getElementById("locStatusFilter").onchange = renderLocRows;
  document.getElementById("locSearch").oninput = renderLocRows;
  document.getElementById("locRefresh").onclick = () => loadAdminLocations();
  document.getElementById("locRows").onclick = onLocAction;
  renderLocRows();
  loadAdminLocations({ quiet: true });
}

async function loadAdminLocations({ quiet = false } = {}) {
  if (!currentUser || adminLocationsLoading) return;
  adminLocationsLoading = true;
  try {
    const out = await locRequest("");
    adminLocations = Array.isArray(out.locations) ? out.locations : [];
    adminLocationCounts = out.counts || adminLocationCounts;
    adminLocationsUpdated = new Date();
    renderLocRows();
  } catch (e) {
    if (!quiet) toast("Could not load submitted locations: " + e.message);
  } finally {
    adminLocationsLoading = false;
  }
}

// Runs one change for one location: blocks repeat clicks, then reloads the list so every row is current.
// Reloads the Hub List (hub-management.js) so an approved location shows there straight away.
async function refreshHubListAfterLocationChange() {
  if (typeof loadHubs !== "function") return;
  const ok = await loadHubs({ quiet: true });
  if (ok && currentPage === "hub" && typeof refreshHubList === "function") refreshHubList();
}

async function runLocChange(id, work) {
  if (adminLocationsBusy.has(id)) return;
  adminLocationsBusy.add(id);
  renderLocRows();
  try {
    await work();
    await loadAdminLocations({ quiet: true });
    await refreshHubListAfterLocationChange();
    return true;
  } catch (e) {
    toast(e.message);
    return false;
  } finally {
    adminLocationsBusy.delete(id);
    renderLocRows();
  }
}

function onLocAction(e) {
  const btn = e.target.closest("[data-loc-action]");
  if (!btn || btn.disabled) return;
  const id = btn.dataset.id;
  const loc = adminLocations.find((l) => l.id === id);
  if (!loc) return;
  switch (btn.dataset.locAction) {
    case "approve":
      approveLocation(loc);
      break;
    case "reject":
      rejectLocationModal(loc);
      break;
    case "direction":
      window.open(locDirectionsUrl(loc), "_blank", "noopener");
      break;
    case "edit":
      editLocationModal(loc);
      break;
    case "delete":
      deleteLocationModal(loc);
      break;
  }
}

function approveLocation(loc) {
  runLocChange(loc.id, async () => {
    const out = await locRequest("/" + encodeURIComponent(loc.id) + "/approve", { method: "POST" });
    toast(out.message || "Location approved. It is now an active hub.");
  });
}

function rejectLocationModal(loc) {
  openModal(`
    <h3>Reject Location</h3>
    <p class="muted">${esc(loc.id)} • ${esc(loc.name)}, ${esc(loc.city)}. The applicant will see the status Rejected and this reason.</p>
    <form id="locRejectForm" class="form-grid">
      <div class="field span2"><label for="locRejectReason">Reason (optional)</label>
        <textarea id="locRejectReason" maxlength="300" placeholder="e.g. PIN code does not match the area"></textarea></div>
      <div class="modal-actions span2">
        <button type="button" class="ghost" onclick="closeModal()">Cancel</button>
        <button class="primary danger" type="submit">Reject Location</button>
      </div>
    </form>`);
  document.getElementById("locRejectForm").onsubmit = (e) => {
    e.preventDefault();
    const reason = document.getElementById("locRejectReason").value;
    closeModal();
    runLocChange(loc.id, async () => {
      await locRequest("/" + encodeURIComponent(loc.id) + "/reject", { method: "POST", body: { reason } });
      toast("Location rejected.");
    });
  };
}

function editLocationModal(loc) {
  const values = { name: loc.name, state: loc.state || "", city: loc.city, district: loc.district, area: loc.area, pin: loc.pin, url: loc.url || "" };
  const hubNote =
    loc.status === LOC_STATUS.ACTIVE && loc.hub
      ? ` This location is in Hub List as “${esc(loc.hub.name)}”; saving also updates that hub.`
      : "";
  openModal(`
    <h3>Edit Location</h3>
    <p class="muted">${esc(loc.id)} • Status: ${esc(loc.status)}. Changes appear in the Admin and partner portals straight away.${hubNote}</p>
    <form id="locEditForm" class="form-grid" novalidate>
      ${LOC_EDIT_FIELDS.map((f) =>
        f.select
          ? `<div class="field" data-loc-field="${f.key}"><label for="locEdit-${f.key}">${esc(f.label)} <span class="req">*</span></label>
          <select id="locEdit-${f.key}" autocomplete="off"><option value="">Select State / Union Territory</option>${f.select
            .map((o) => `<option value="${esc(o)}"${o === values[f.key] ? " selected" : ""}>${esc(o)}</option>`)
            .join("")}</select>
          <small class="field-msg" role="alert"></small></div>`
          : `<div class="field" data-loc-field="${f.key}"><label for="locEdit-${f.key}">${esc(f.label)}${f.optional ? "" : ' <span class="req">*</span>'}</label>
          <input id="locEdit-${f.key}" maxlength="${f.max}" value="${esc(values[f.key])}" autocomplete="off"${f.key === "pin" ? ' inputmode="numeric"' : ""}>
          <small class="field-msg" role="alert"></small></div>`,
      ).join("")}
      <p id="locEditMsg" class="field-msg span2" role="alert"></p>
      <div class="modal-actions span2">
        <button type="button" class="ghost" onclick="closeModal()">Cancel</button>
        <button class="primary" type="submit" id="locEditSave">Save Changes</button>
      </div>
    </form>`);
  const form = document.getElementById("locEditForm");
  form.addEventListener("input", (e) => {
    const wrap = e.target.closest("[data-loc-field]");
    if (wrap) {
      wrap.classList.remove("has-error");
      wrap.querySelector(".field-msg").textContent = "";
    }
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = document.getElementById("locEditSave");
    if (btn.disabled) return;
    const body = {};
    LOC_EDIT_FIELDS.forEach((f) => {
      body[f.key] = document.getElementById("locEdit-" + f.key).value.replace(/\s+/g, " ").trim();
    });
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      await locRequest("/" + encodeURIComponent(loc.id), { method: "PATCH", body });
      closeModal();
      toast("Location updated.");
      await loadAdminLocations({ quiet: true });
    } catch (err) {
      const list = err.errors && err.errors.length ? err.errors : err.field ? [{ field: err.field, message: err.message }] : [];
      if (list.length) {
        list.forEach((x) => {
          const wrap = form.querySelector(`[data-loc-field="${x.field}"]`);
          if (wrap) {
            wrap.classList.add("has-error");
            wrap.querySelector(".field-msg").textContent = x.message;
          }
        });
      } else {
        document.getElementById("locEditMsg").textContent = err.message;
      }
      btn.disabled = false;
      btn.textContent = "Save Changes";
    }
  };
}

function deleteLocationModal(loc) {
  openModal(`
    <h3>Delete Location?</h3>
    <p><b>${esc(loc.id)} • ${esc(loc.name)}</b>, ${esc(loc.city)}, ${esc(loc.district)}</p>
    <p class="muted">This removes the location from the Admin list and from the ${esc(loc.appliedRole === "franchise" ? "franchise" : "vendor")} portal. This cannot be undone.</p>
    ${
      loc.status === LOC_STATUS.ACTIVE && loc.hub
        ? `<p class="field-msg span2" role="note">This location is approved. Its hub “${esc(loc.hub.name)}” in Hub List will be set to <b>Inactive</b>. The hub and its details are kept, not deleted.</p>`
        : ""
    }
    <div class="modal-actions">
      <button type="button" class="ghost" onclick="closeModal()">Cancel</button>
      <button type="button" class="primary danger" id="locDeleteConfirm">Yes, Delete</button>
    </div>`);
  document.getElementById("locDeleteConfirm").onclick = () => {
    closeModal();
    runLocChange(loc.id, async () => {
      await locRequest("/" + encodeURIComponent(loc.id), { method: "DELETE" });
      toast("Location deleted.");
    });
  };
}

// Keeps the list current while the Hub Management page is open.
setInterval(() => {
  if (currentPage === "hub" && !document.hidden && document.getElementById("adminLocationsCard")) {
    loadAdminLocations({ quiet: true });
    refreshHubListAfterLocationChange();
  }
}, 30000);

window.mountAdminLocations = mountAdminLocations;
