// My Locations and Add / Edit / View Location for the Franchise and Vendor portals.
// This file is identical in both portal folders. Everything is saved on the server (the same database as the Admin
// Portal), and each partner sees only the locations of their own account.
// Application statuses shown to partners: Pending, Approved, Rejected (the Admin Portal uses Pending Approval / Active / Rejected).
(function () {
  const API_BASE =
    window.OTW_API_BASE ||
    (location.protocol === "file:" ? "http://localhost:8080" : "");
  const REFRESH_MS = 30000; // statuses refresh every 30 seconds while the portal is open
  const STATUS = { PENDING: "Pending Approval", ACTIVE: "Active", REJECTED: "Rejected" };
  const STATUS_LABEL = { [STATUS.PENDING]: "Pending", [STATUS.ACTIVE]: "Approved", [STATUS.REJECTED]: "Rejected" };
  // Official State / Union Territory names (the server checks the same list).
  const STATES = [
    "Andaman and Nicobar Islands", "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chandigarh",
    "Chhattisgarh", "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Goa", "Gujarat", "Haryana",
    "Himachal Pradesh", "Jammu and Kashmir", "Jharkhand", "Karnataka", "Kerala", "Ladakh", "Lakshadweep",
    "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Puducherry",
    "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal",
  ];
  const STATE_KEYS = new Set(STATES.map((s) => s.toLowerCase()));
  // Form fields, in the order of the Add Location form.
  const FIELDS = [
    { key: "name", id: "locName", label: "Location Name" },
    { key: "state", id: "locState", label: "State" },
    { key: "city", id: "locCity", label: "City / Town" },
    { key: "district", id: "locDistrict", label: "District" },
    { key: "area", id: "locArea", label: "Area" },
    { key: "pin", id: "locPin", label: "PIN Code" },
    { key: "url", id: "locUrl", label: "Location URL" },
  ];
  const $ = (s) => document.querySelector(s);
  const esc = (v = "") =>
    String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  let locations = [];
  let defaultState = "";
  let loaded = false;
  let loading = false;
  let busy = false; // true while a save, edit or delete request is in flight (blocks repeated clicks)
  let mode = "add"; // "add" | "edit" | "view"
  let editingId = "";
  let submissionKey = ""; // one key per opened add form, so a retry cannot create a second location

  function notify(msg, isError) {
    if (typeof window.portalToast === "function") window.portalToast(msg, isError);
    else alert(msg);
  }

  async function request(path, { method = "GET", body } = {}) {
    let r;
    try {
      r = await fetch(API_BASE + path, {
        method,
        credentials: "include",
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error("Could not reach the server. Check your connection and try again.");
    }
    let out = {};
    try {
      out = await r.json();
    } catch (e) {}
    if (!r.ok) {
      const err = new Error(out.error || "Request failed (" + r.status + ").");
      err.status = r.status;
      err.field = out.field || "";
      err.errors = out.errors || [];
      throw err;
    }
    return out;
  }

  const statusLabel = (s) => STATUS_LABEL[s] || s;
  function statusHtml(s) {
    const tone = s === STATUS.ACTIVE ? "approved" : s === STATUS.REJECTED ? "rejected" : "pending";
    return `<span class="status ${tone}">${esc(statusLabel(s))}</span>`;
  }
  function dateText(iso) {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  }
  // Only web links are shown as clickable.
  function urlHtml(url) {
    if (!/^https?:\/\//i.test(url || "")) return '<span class="muted">—</span>';
    return `<a class="location-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open map ↗</a>`;
  }
  // Edit and Delete are allowed while a location is not approved. Approved locations can only be viewed.
  const canChange = (l) => l.status !== STATUS.ACTIVE;

  function actionsHtml(l) {
    const id = esc(l.id);
    const parts = [`<button type="button" class="link" data-loc-action="view" data-id="${id}">View</button>`];
    if (canChange(l)) {
      parts.push(`<button type="button" class="link" data-loc-action="edit" data-id="${id}">Edit</button>`);
      parts.push(`<button type="button" class="member-delete" data-loc-action="delete" data-id="${id}">Delete</button>`);
    } else {
      parts.push(`<small class="muted">Approved</small>`);
    }
    return `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${parts.join("")}</div>`;
  }

  function visibleRows() {
    const q = ($("#locationSearch")?.value || "").trim().toLowerCase();
    if (!q) return locations;
    return locations.filter((l) =>
      [l.id, l.name, l.state, l.city, l.district, l.area, l.pin, l.url, statusLabel(l.status)].join(" ").toLowerCase().includes(q),
    );
  }

  function render() {
    const body = $("#locationTable");
    if (!body) return;
    const rows = visibleRows();
    body.innerHTML = rows.length
      ? rows
          .map(
            (l) =>
              `<tr><td><b>${esc(l.id)}</b></td><td>${esc(l.name)}</td><td>${esc(l.city)}</td><td>${esc(l.district)}</td><td>${esc(l.area)}</td><td>${esc(l.pin)}</td><td>${urlHtml(l.url)}</td><td>${statusHtml(l.status)}${
                l.status === STATUS.REJECTED && l.rejectReason ? `<br><small class="muted">Reason: ${esc(l.rejectReason)}</small>` : ""
              }<br><small class="muted">Submitted ${esc(dateText(l.createdAt))}</small></td><td>${actionsHtml(l)}</td></tr>`,
          )
          .join("")
      : `<tr><td colspan="9" class="muted">${
          locations.length
            ? "No locations match your search."
            : loaded
              ? "No locations yet. Click “Add Location” to submit one for approval."
              : "Loading your locations…"
        }</td></tr>`;

    const total = locations.length;
    const active = locations.filter((l) => l.status === STATUS.ACTIVE).length;
    const pending = locations.filter((l) => l.status === STATUS.PENDING).length;
    if ($("#statLocations")) $("#statLocations").textContent = total;
    if ($("#statActive")) $("#statActive").textContent = active;
    if ($("#statPending")) $("#statPending").textContent = pending;

    const recent = $("#recentLocations");
    if (recent)
      recent.innerHTML =
        locations
          .slice(0, 3)
          .map(
            (l) =>
              `<div class="list-row"><span><b>${esc(l.name)}</b><br><small class="muted">${esc(l.id)} • ${esc(l.city)}, ${esc(l.district)}</small></span>${statusHtml(l.status)}</div>`,
          )
          .join("") || '<div class="notice">No locations added yet.</div>';
  }

  // Loads this partner's locations. A failure keeps the rows already on screen and shows the reason.
  async function load({ quiet = false } = {}) {
    if (loading) return;
    loading = true;
    try {
      const out = await request("/api/portal/locations");
      locations = Array.isArray(out.locations) ? out.locations : [];
      defaultState = out.defaultState || "";
      loaded = true;
      render();
    } catch (err) {
      if (err.status === 401) {
        loaded = false;
        locations = [];
        render();
        if (typeof window.sessionEnded === "function") window.sessionEnded();
        return;
      }
      if (!quiet) notify(err.message, true);
    } finally {
      loading = false;
    }
  }

  // ---------- Add / Edit / View form (one modal for all three) ----------
  function fillStateOptions(select) {
    select.innerHTML =
      '<option value="">Select State / Union Territory</option>' +
      STATES.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
  }

  function setFormMode(nextMode, title) {
    mode = nextMode;
    const readOnly = nextMode === "view";
    $("#locationModalTitle") && ($("#locationModalTitle").textContent = title);
    FIELDS.forEach((f) => {
      const el = $("#" + f.id);
      if (!el) return;
      if (el.tagName === "SELECT") el.disabled = readOnly;
      else el.readOnly = readOnly;
    });
    const save = $("#saveLocation");
    if (save) save.hidden = readOnly;
  }

  function openForm(nextMode, location) {
    const modal = $("#locationModal");
    if (!modal) return;
    const select = $("#locState");
    if (select && !select.options.length) fillStateOptions(select);
    clearErrors();
    setSaving(false);
    FIELDS.forEach((f) => {
      const el = $("#" + f.id);
      if (!el) return;
      if (f.key === "url") el.value = location?.url || "";
      else if (f.key === "state") el.value = location?.state || defaultState || "";
      else el.value = location ? location[f.key] || "" : "";
    });
    if (nextMode === "add") {
      editingId = "";
      // a new key for each new add form; a retry of the same form reuses it, so the server never makes a duplicate
      submissionKey =
        (window.crypto && crypto.randomUUID && crypto.randomUUID()) ||
        "k" + Date.now() + "-" + Math.random().toString(36).slice(2);
      setFormMode("add", "Add " + roleName() + " Location");
    } else if (nextMode === "edit") {
      editingId = location.id;
      setFormMode("edit", "Edit " + roleName() + " Location " + location.id);
      setFormNote(
        location.status === STATUS.REJECTED
          ? "This location was rejected. Saving it sends it back to Admin Approval."
          : "",
      );
    } else {
      editingId = location.id;
      setFormMode("view", "View " + roleName() + " Location " + location.id);
    }
    modal.classList.remove("hidden");
    if (nextMode !== "view") $("#locName")?.focus();
  }

  // "Franchise" or "Vendor", from the page's own role attribute.
  function roleName() {
    return $("#locations")?.dataset.locationRole || "";
  }

  function setFormNote(text) {
    const n = $("#locFormNote");
    if (!n) return;
    n.textContent = text;
    n.hidden = !text;
  }

  function closeForm() {
    $("#locationModal")?.classList.add("hidden");
    setFormNote("");
  }
  // The Close and Cancel buttons do nothing while a save is still running, so a save is never cut off half way.
  function closeFromButton() {
    if (!busy) closeForm();
  }

  function clearErrors() {
    FIELDS.forEach((f) => {
      const el = $("#" + f.id);
      if (el) el.classList.remove("input-error");
      const msg = $('[data-loc-err="' + f.key + '"]');
      if (msg) msg.textContent = "";
    });
    const general = $("#locFormMsg");
    if (general) general.textContent = "";
  }

  function showFieldError(key, message) {
    const f = FIELDS.find((x) => x.key === key);
    const msg = $('[data-loc-err="' + key + '"]');
    if (msg) msg.textContent = message;
    if (f && $("#" + f.id)) $("#" + f.id).classList.add("input-error");
  }

  // Client-side checks mirror the server rules; the server checks everything again and its messages win.
  function readForm() {
    clearErrors();
    const values = {};
    let firstBad = null;
    for (const f of FIELDS) {
      const el = $("#" + f.id);
      const raw = (el?.value || "").replace(/\s+/g, " ").trim();
      values[f.key] = f.key === "url" ? (el?.value || "").trim() : raw;
      let message = "";
      if (f.key === "url") {
        if (raw && !/^(https?:\/\/|[a-z0-9-]+\.)/i.test(raw)) message = "Enter a full web link, for example a Google Maps link.";
      } else if (!raw) message = f.label + " is required.";
      else if (f.key === "state" && !STATE_KEYS.has(raw.toLowerCase())) message = "Choose the State from the list.";
      else if (f.key === "pin" && !/^[1-9][0-9]{5}$/.test(raw)) message = "Enter a valid 6-digit PIN code (it cannot start with 0).";
      if (message) {
        showFieldError(f.key, message);
        if (!firstBad) firstBad = el;
      }
    }
    if (firstBad) firstBad.focus();
    return firstBad ? null : values;
  }

  function setSaving(on) {
    const btn = $("#saveLocation");
    if (!btn) return;
    btn.disabled = on;
    btn.textContent = on ? "Saving…" : "Save Location";
  }

  async function submitForm(e) {
    e.preventDefault();
    if (busy || mode === "view") return;
    const values = readForm();
    if (!values) return;
    busy = true;
    setSaving(true);
    try {
      if (mode === "edit") {
        await request("/api/portal/locations/" + encodeURIComponent(editingId), { method: "PATCH", body: values });
        closeForm();
        await load({ quiet: true });
        notify("Location updated. It is waiting for Admin Approval.");
      } else {
        const out = await request("/api/portal/locations", { method: "POST", body: { ...values, submissionKey } });
        closeForm();
        await load({ quiet: true });
        notify(
          out.duplicate
            ? "This location was already submitted. Its status is shown in My Locations."
            : "Location submitted successfully. Waiting for Admin Approval.",
        );
        submissionKey = "";
      }
    } catch (err) {
      if (Array.isArray(err.errors) && err.errors.length) err.errors.forEach((x) => showFieldError(x.field, x.message));
      else if (err.field) showFieldError(err.field, err.message);
      else $("#locFormMsg") && ($("#locFormMsg").textContent = err.message);
      if (err.status === 401 && typeof window.sessionEnded === "function") window.sessionEnded();
    } finally {
      busy = false;
      setSaving(false);
    }
  }

  // ---------- row actions ----------
  function findLocation(id) {
    return locations.find((l) => l.id === id);
  }

  async function removeLocation(loc) {
    if (busy) return;
    if (!confirm(`Delete ${loc.id} • ${loc.name}? This cannot be undone.`)) return;
    busy = true;
    try {
      await request("/api/portal/locations/" + encodeURIComponent(loc.id), { method: "DELETE" });
      await load({ quiet: true });
      notify("Location deleted.");
    } catch (err) {
      notify(err.message, true);
      if (err.status === 401 && typeof window.sessionEnded === "function") window.sessionEnded();
    } finally {
      busy = false;
    }
  }

  function onTableClick(e) {
    const btn = e.target.closest("[data-loc-action]");
    if (!btn) return;
    const loc = findLocation(btn.dataset.id);
    if (!loc) return notify("This location is no longer in your list. It has been refreshed.", true);
    if (btn.dataset.locAction === "view") openForm("view", loc);
    else if (btn.dataset.locAction === "edit") openForm("edit", loc);
    else if (btn.dataset.locAction === "delete") removeLocation(loc);
  }

  // Opens My Locations (the page) and then the Add Location form.
  function openAddFromAnywhere() {
    const nav = document.querySelector('button.nav[data-page="locations"]');
    if (nav && !$("#locations")?.offsetParent) nav.click();
    openForm("add");
  }

  function bind() {
    const section = $("#locations");
    if (!section || section.dataset.locationsBound) return;
    section.dataset.locationsBound = "1";
    $("#addLocation")?.addEventListener("click", () => openForm("add"));
    $("#closeLocationModal")?.addEventListener("click", closeFromButton);
    $("#cancelLocation")?.addEventListener("click", closeFromButton);
    $("#locationForm")?.addEventListener("submit", submitForm);
    $("#locationSearch")?.addEventListener("input", render);
    $("#locationTable")?.addEventListener("click", onTableClick);
    $("#locationForm")?.addEventListener("input", (e) => {
      const f = FIELDS.find((x) => x.id === e.target.id);
      if (f) {
        const msg = $('[data-loc-err="' + f.key + '"]');
        if (msg) msg.textContent = "";
        e.target.classList.remove("input-error");
      }
    });
    // Dashboard "Add Location" buttons open the form directly.
    document.addEventListener("click", (e) => {
      if (e.target.closest("[data-open-location-add]")) {
        e.preventDefault();
        openAddFromAnywhere();
        return;
      }
      // Opening the page loads fresh data.
      const jump = e.target.closest('[data-page="locations"], [data-page-jump="locations"]');
      if (jump) setTimeout(() => load({ quiet: true }), 0);
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && loaded) load({ quiet: true });
    });
    setInterval(() => {
      if (!document.hidden && loaded) load({ quiet: true });
    }, REFRESH_MS);
  }

  // Called by app.js after a successful sign-in (and on page load if already signed in).
  window.startPartnerLocations = function () {
    bind();
    load({ quiet: true });
  };
  window.refreshPartnerLocations = () => load({ quiet: true });
  document.addEventListener("DOMContentLoaded", bind);
})();
