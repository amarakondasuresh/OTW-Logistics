// Rider Applications for the Franchise Portal. A franchise registers its riders here (documents required),
// sees the status of each one (PENDING, APPROVED or REJECTED) and the remarks given by On The Way Logistics.
// Only the admin decides (approve / reject); this page is read-only for decisions. Each franchise sees only its own riders.
// Uses globals from app.js: PORTAL, API_BASE, $, $$, esc, portalToast, showPage, sessionEnded.
(() => {
  const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
  const MAX_BYTES = 5 * 1024 * 1024;
  const STATUS_CLASS = {
    PENDING: "pending",
    APPROVED: "approved",
    REJECTED: "rejected",
  };
  const FIELD_IDS = {
    riderId: "rrId",
    riderName: "rrName",
    mobile: "rrMobile",
    hubPincode: "rrPin",
    hubLocation: "rrHub",
    selfie: "rrSelfie",
    aadhaar: "rrAadhaar",
  };
  let items = [];
  let objectUrl = null;
  let loading = false;

  const api = (path) =>
    `${API_BASE}/api/rider-registrations${path}?portal=${PORTAL}`;
  const dateText = (v) => {
    const d = new Date(v);
    return isNaN(d)
      ? ""
      : d.toLocaleString("en-IN", {
          day: "2-digit",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
  };
  const sizeText = (n) =>
    n >= 1048576
      ? (n / 1048576).toFixed(1) + " MB"
      : Math.max(1, Math.round(n / 1024)) + " KB";
  const statusBadge = (s) =>
    `<span class="status ${STATUS_CLASS[s] || "pending"}">${esc(s)}</span>`;
  const cleanMobile = (v) => {
    let d = String(v || "").replace(/\D/g, "");
    if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
    if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
    return /^[6-9]\d{9}$/.test(d) ? d : "";
  };

  // Same rules as the server. Returns [fieldId, message] for the first problem, or null.
  function checkFields(v) {
    if (!/^[A-Za-z0-9][A-Za-z0-9\-_\/]{1,39}$/.test(v.id))
      return [
        "rrId",
        "Rider ID must be 2 to 40 letters, numbers, dashes or slashes, with no spaces.",
      ];
    if (!v.name) return ["rrName", "Enter the rider name."];
    if (/\d/.test(v.name))
      return ["rrName", "The rider name cannot contain numbers."];
    if (
      !/^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u.test(v.name) ||
      (v.name.match(/\p{L}/gu) || []).length < 2
    )
      return [
        "rrName",
        "The rider name can only contain letters, spaces and . ' -",
      ];
    if (!cleanMobile(v.mobile))
      return [
        "rrMobile",
        "Enter a 10-digit mobile number starting with 6, 7, 8 or 9.",
      ];
    if (!/^[1-9]\d{5}$/.test(v.pin))
      return ["rrPin", "Enter the 6-digit hub pincode."];
    if (v.hub.length < 2) return ["rrHub", "Enter the hub location."];
    return null;
  }

  async function call(url, { method = "GET", body } = {}) {
    const isForm = body instanceof FormData;
    const r = await fetch(url, {
      method,
      credentials: "include",
      headers: body && !isForm ? { "Content-Type": "application/json" } : {},
      body:
        body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
    let out = {};
    try {
      out = await r.json();
    } catch (e) {
      /* not JSON */
    }
    if (r.status === 401) {
      if (typeof sessionEnded === "function") sessionEnded();
      throw new Error("Please sign in again.");
    }
    if (r.status === 403 && out.code === "PASSWORD_CHANGE_REQUIRED")
      throw new Error("Please choose your password first.");
    if (!r.ok) {
      const err = new Error(out.error || "Request failed (" + r.status + ")");
      err.field = out.field || "";
      throw err;
    }
    return out;
  }

  async function load({ quiet = false } = {}) {
    if (loading || !document.getElementById("rrRows")) return;
    loading = true;
    try {
      items = (await call(api(""))).items || [];
      render();
    } catch (e) {
      if (!quiet)
        portalToast(
          "Could not load rider applications: " +
            (e.message === "Failed to fetch"
              ? "no connection to the server."
              : e.message),
          true,
        );
    } finally {
      loading = false;
    }
  }

  function filtered() {
    const val = (id) => ($("#" + id)?.value || "").trim().toLowerCase();
    const f = {
      id: val("rrFilterId"),
      name: val("rrFilterName"),
      hub: val("rrFilterHub"),
    };
    return items.filter(
      (r) =>
        (!f.id || r.riderId.toLowerCase().includes(f.id)) &&
        (!f.name || r.riderName.toLowerCase().includes(f.name)) &&
        (!f.hub || r.hubLocation.toLowerCase().includes(f.hub)),
    );
  }

  function render() {
    const body = $("#rrRows");
    if (!body) return;
    const count = (s) => items.filter((r) => r.status === s).length;
    $("#rrTotal").textContent = items.length;
    $("#rrPending").textContent = count("PENDING");
    $("#rrApproved").textContent = count("APPROVED");
    $("#rrRejected").textContent = count("REJECTED");
    const list = filtered();
    body.innerHTML = list.map(row).join("");
    const empty = $("#rrEmpty");
    empty.textContent = items.length
      ? "No rider applications match these filters."
      : "No rider applications yet. Use “＋ Add New Member” to register a rider.";
    empty.classList.toggle("hidden", list.length > 0);
  }

  // One row per rider. Clicking the row opens its details, where the decision and admin remarks are shown. The Selfie and
  // Aadhaar buttons open those documents directly.
  function row(r) {
    const id = esc(r.id);
    return (
      `<tr class="rr-row" data-rr-id="${id}" tabindex="0" title="Open details to approve or reject">` +
      `<td><b>${esc(r.riderId)}</b><br><small class="muted">${esc(r.applicationId)}</small></td><td>${esc(r.riderName)}</td><td>${esc(r.mobileNumber)}</td><td>${esc(r.hubPincode)}</td><td>${esc(r.hubLocation)}</td>` +
      `<td><button class="link" type="button" data-rr-doc="selfie" data-rr-id="${id}" data-rr-title="Selfie">View selfie</button></td>` +
      `<td><button class="link" type="button" data-rr-doc="aadhaar" data-rr-id="${id}" data-rr-title="Aadhaar">Preview Aadhaar</button></td>` +
      `<td>${esc(dateText(r.createdAt))}</td><td>${statusBadge(r.status)}</td></tr>`
    );
  }

  // ---------- modal ----------
  function openModal(title, html, wide = false) {
    $("#rrModalTitle").textContent = title;
    $("#rrModalBody").innerHTML = html;
    $("#rrModalCard").classList.toggle("wide", wide);
    $("#rrModal").classList.remove("hidden");
  }
  function closeModal() {
    revokeDocument();
    $("#rrModal").classList.add("hidden");
    $("#rrModalBody").innerHTML = "";
  }
  function revokeDocument() {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  }

  // Shows a selfie or Aadhaar for viewing only, fetched with this partner's own session.
  async function openDocument(id, kind, title) {
    try {
      const r = await fetch(
        api("/" + encodeURIComponent(id) + "/files/" + kind),
        { credentials: "include" },
      );
      if (r.status === 401) {
        if (typeof sessionEnded === "function") sessionEnded();
        return;
      }
      if (!r.ok) {
        let m = "Could not open the document.";
        try {
          m = (await r.json()).error || m;
        } catch (e) {
          /* keep default */
        }
        return portalToast(m, true);
      }
      const blob = await r.blob();
      revokeDocument();
      objectUrl = URL.createObjectURL(blob);
      const view =
        blob.type === "application/pdf"
          ? `<iframe src="${objectUrl}" title="${esc(title)}"></iframe>`
          : `<img src="${objectUrl}" alt="${esc(title)}">`;
      openModal(
        title,
        `<div class="rr-doc-view">${view}</div><p class="muted">Shown only to you. Close this window when you are done.</p><div class="rr-modal-actions"><button type="button" class="secondary" data-rr-close>Close</button></div>`,
        true,
      );
      $("#rrModalBody").querySelector("[data-rr-close]").onclick = closeModal;
    } catch (e) {
      portalToast(
        "Could not reach the server. Check your connection and try again.",
        true,
      );
    }
  }

  // What a franchise reads about the decision. The approver's login is never shown.
  function decisionText(r) {
    if (r.status === "PENDING")
      return "Waiting for review by On The Way Logistics.";
    const when = r.approvalDate || r.updatedAt;
    return (
      (r.status === "APPROVED" ? "Approved" : "Rejected") +
      (when ? " on " + dateText(when) : "") +
      "."
    );
  }

  async function viewDetail(id) {
    try {
      const r = (await call(api("/" + encodeURIComponent(id)))).item;
      items = items.map((x) => (x.id === r.id ? r : x));
      const history = (r.history || [])
        .map(
          (h) =>
            `<tr><td>${esc(dateText(h.at))}</td><td>${esc(h.fromStatus ? h.fromStatus + " → " : "")}${esc(h.toStatus)}</td><td>${esc(h.actor)}</td><td>${esc(h.remarks || "—")}</td></tr>`,
        )
        .join("");
      openModal(
        `${r.riderName} · ${r.riderId}`,
        `<div class="rr-grid">` +
          `<div><b>Application ID</b><p>${esc(r.applicationId)}</p></div>` +
          `<div><b>Status</b><p>${statusBadge(r.status)}</p></div>` +
          `<div><b>Mobile number</b><p>${esc(r.mobileNumber)}</p></div>` +
          `<div><b>Hub pincode</b><p>${esc(r.hubPincode)}</p></div>` +
          `<div><b>Hub location</b><p>${esc(r.hubLocation)}</p></div>` +
          `<div><b>Applied on</b><p>${esc(dateText(r.createdAt))}</p></div>` +
          `<div class="wide"><b>${r.status === "PENDING" ? "Review" : "Decision"}</b><p>${esc(decisionText(r))}</p></div>` +
          (r.decisionRemarks
            ? `<div class="wide"><b>Admin remarks</b><p>${esc(r.decisionRemarks)}</p></div>`
            : "") +
          `</div>` +
          `<div class="rr-doc-buttons"><button type="button" class="secondary" data-rr-doc="selfie" data-rr-title="Selfie · ${esc(r.riderName)}">View selfie</button><button type="button" class="secondary" data-rr-doc="aadhaar" data-rr-title="Aadhaar · ${esc(r.riderName)}">Preview Aadhaar</button></div>` +
          `<h4>History</h4><div class="table-wrap"><table><thead><tr><th>When</th><th>Change</th><th>By</th><th>Remarks</th></tr></thead><tbody>${history || '<tr><td colspan="4">No history.</td></tr>'}</tbody></table></div>` +
          `<div class="rr-modal-actions"><button type="button" class="secondary" data-rr-close>Close</button></div>`,
        true,
      );
      const body = $("#rrModalBody");
      body.querySelector("[data-rr-close]").onclick = closeModal;
      body
        .querySelectorAll("[data-rr-doc]")
        .forEach(
          (b) =>
            (b.onclick = () =>
              openDocument(r.id, b.dataset.rrDoc, b.dataset.rrTitle)),
        );
      render();
    } catch (e) {
      portalToast(e.message, true);
    }
  }

  // ---------- add a rider ----------
  function fileProblem(input, kind) {
    const f = input.files[0];
    if (!f) return "";
    const allowed =
      kind === "selfie" ? IMAGE_TYPES : [...IMAGE_TYPES, "application/pdf"];
    if (!allowed.includes(f.type))
      return kind === "selfie"
        ? "The selfie must be a JPG, PNG or WEBP image."
        : "The Aadhaar card must be a JPG, PNG, WEBP image or PDF.";
    if (f.size > MAX_BYTES)
      return "That file is larger than 5 MB. Please choose a smaller file.";
    return "";
  }
  function showPreview(box, input, kind) {
    const f = input.files[0];
    box.innerHTML = "";
    if (!f) return;
    const url = URL.createObjectURL(f);
    box.innerHTML =
      (f.type === "application/pdf"
        ? '<span class="rr-pdf">PDF</span>'
        : `<img src="${url}" alt="Preview of ${esc(f.name)}">`) +
      `<span class="rr-file-name"><b>${esc(f.name)}</b><small>${esc(sizeText(f.size))}</small></span><button type="button" class="secondary" data-rr-preview>Preview</button>`;
    box.querySelector("[data-rr-preview]").onclick = () =>
      window.open(url, "_blank", "noopener");
  }
  function formFail(field, message) {
    const err = $("#rrFormError");
    if (err) err.textContent = message || "Could not save the rider.";
    const el = document.getElementById(FIELD_IDS[field] || field);
    if (el && el.focus) el.focus();
  }

  // Choosing the delivery-app screenshot fills in Rider ID and Rider Name (read on the server). Values already typed
  // are never overwritten, and filled fields are highlighted so the user checks them.
  async function autoFillFromScreenshot(file) {
    const idEl = $("#rrId"),
      nameEl = $("#rrName"),
      note = $("#rrOcrNote");
    if (!file || !idEl || !nameEl || !note) return;
    if (idEl.value.trim() && nameEl.value.trim()) return;
    note.className = "autofill-status busy wide";
    note.textContent = "Reading the Rider ID and name from the screenshot…";
    try {
      const fd = new FormData();
      fd.append("file", file, file.name);
      const r = await fetch(
        `${API_BASE}/api/read-rider-screenshot?portal=${PORTAL}`,
        { method: "POST", credentials: "include", body: fd },
      );
      const out = await r.json().catch(() => ({}));
      if (!document.body.contains(idEl)) return; // the form was closed meanwhile
      if (!r.ok) throw new Error(out.error || "");
      const filled = [];
      if (out.read?.partnerId && !idEl.value.trim()) {
        idEl.value = out.read.partnerId;
        idEl.classList.add("autofilled");
        filled.push("Rider ID");
      }
      if (out.read?.name && !nameEl.value.trim()) {
        nameEl.value = out.read.name;
        nameEl.classList.add("autofilled");
        filled.push("Rider Name");
      }
      note.className =
        "autofill-status wide " + (filled.length ? "ok" : "warn");
      note.textContent = filled.length
        ? `${filled.join(" and ")} filled in from the screenshot. Please check before saving.`
        : out.read?.partnerId || out.read?.name
          ? ""
          : "No Partner ID was found in this image. Please type the details.";
    } catch (e) {
      if (!document.body.contains(note)) return;
      note.className = "autofill-status warn wide";
      note.textContent =
        "The screenshot could not be read automatically. Please type the details.";
    }
  }
  function openAddForm() {
    openModal(
      "Add New Member",
      `<p class="muted">Register a rider with both documents. The application is saved at once and shows here as <b>PENDING</b> until On The Way Logistics approves or rejects it.</p>` +
        `<form id="rrForm" class="rr-form" novalidate>` +
        `<label>Rider ID *<input id="rrId" maxlength="40" autocomplete="off" placeholder="e.g. 28274601"></label>` +
        `<label>Rider Name *<input id="rrName" maxlength="100" autocomplete="off"></label>` +
        `<label>Mobile Number *<input id="rrMobile" inputmode="numeric" maxlength="16" autocomplete="off" placeholder="10-digit mobile number"></label>` +
        `<label>Hub Pincode *<input id="rrPin" inputmode="numeric" maxlength="6" autocomplete="off" placeholder="6-digit pincode"></label>` +
        `<label class="wide">Hub Location *<input id="rrHub" maxlength="120" autocomplete="off"></label>` +
        `<label class="wide">Rider Selfie / Screenshot *<input id="rrSelfie" type="file" accept="image/jpeg,image/png,image/webp"><small class="muted">JPG, PNG or WEBP image, up to 5 MB.</small></label><div id="rrSelfiePreview" class="rr-preview wide"></div><p id="rrOcrNote" class="autofill-status wide" role="status"></p>` +
        `<label class="wide">Aadhaar Card *<input id="rrAadhaar" type="file" accept="image/jpeg,image/png,image/webp,application/pdf"><small class="muted">JPG, PNG, WEBP or PDF, up to 5 MB. A masked Aadhaar (last 4 digits visible) is recommended.</small></label><div id="rrAadhaarPreview" class="rr-preview wide"></div>` +
        `<p id="rrFormError" class="field-error wide" role="alert"></p>` +
        `<div class="rr-modal-actions wide"><button type="button" class="secondary" data-rr-close>Cancel</button><button type="submit" class="primary" id="rrSubmit">Save / Submit</button></div>` +
        `</form>`,
      true,
    );
    const body = $("#rrModalBody");
    body.querySelector("[data-rr-close]").onclick = closeModal;
    $("#rrPin").oninput = (e) => {
      e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6);
    };
    $("#rrSelfie").onchange = (e) => {
      const p = fileProblem(e.target, "selfie");
      if (p) {
        e.target.value = "";
        $("#rrSelfiePreview").innerHTML = "";
        return formFail("selfie", p);
      }
      $("#rrFormError").textContent = "";
      showPreview($("#rrSelfiePreview"), e.target, "selfie");
      autoFillFromScreenshot(e.target.files[0]);
    };
    $("#rrAadhaar").onchange = (e) => {
      const p = fileProblem(e.target, "aadhaar");
      if (p) {
        e.target.value = "";
        $("#rrAadhaarPreview").innerHTML = "";
        return formFail("aadhaar", p);
      }
      $("#rrFormError").textContent = "";
      showPreview($("#rrAadhaarPreview"), e.target, "aadhaar");
    };
    ["rrId", "rrName"].forEach((id) =>
      $("#" + id).addEventListener("input", (ev) =>
        ev.target.classList.remove("autofilled"),
      ),
    );
    $("#rrForm").onsubmit = submitForm;
    $("#rrId").focus();
  }

  async function submitForm(e) {
    e.preventDefault();
    const v = {
      id: $("#rrId").value.trim(),
      name: $("#rrName").value.replace(/\s+/g, " ").trim(),
      mobile: $("#rrMobile").value.trim(),
      pin: $("#rrPin").value.trim(),
      hub: $("#rrHub").value.replace(/\s+/g, " ").trim(),
    };
    const problem = checkFields(v);
    if (problem) return formFail(problem[0], problem[1]);
    const selfie = $("#rrSelfie").files[0],
      aadhaar = $("#rrAadhaar").files[0];
    if (!selfie)
      return formFail("selfie", "Upload the rider selfie or screenshot.");
    if (!aadhaar) return formFail("aadhaar", "Upload the Aadhaar card.");
    const fd = new FormData();
    fd.append("riderId", v.id);
    fd.append("riderName", v.name);
    fd.append("mobile", cleanMobile(v.mobile));
    fd.append("hubPincode", v.pin);
    fd.append("hubLocation", v.hub);
    fd.append("selfie", selfie, selfie.name);
    fd.append("aadhaar", aadhaar, aadhaar.name);
    const btn = $("#rrSubmit");
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const out = await call(api(""), { method: "POST", body: fd });
      items = [out.item, ...items.filter((x) => x.id !== out.item.id)];
      closeModal();
      showPage("riderApps");
      render();
      portalToast(`${out.item.applicationId} saved as PENDING`);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Save / Submit";
      formFail(err.field, err.message);
      portalToast("Not saved: " + err.message, true);
    }
  }

  // ---------- wiring ----------
  function bind() {
    if (!$("#riderApps")) return;
    ["rrFilterId", "rrFilterName", "rrFilterHub"].forEach((id) => {
      const el = $("#" + id);
      el.oninput = render;
      el.onchange = render;
    });
    $$("[data-rr-refresh]").forEach((b) =>
      b.addEventListener("click", () =>
        load().then(() => portalToast("Up to date")),
      ),
    );
    $("#rrRows").addEventListener("click", (e) => {
      const doc = e.target.closest("button[data-rr-doc]");
      if (doc) {
        const item = items.find((x) => x.id === doc.dataset.rrId);
        if (item)
          openDocument(
            item.id,
            doc.dataset.rrDoc,
            `${doc.dataset.rrTitle} · ${item.riderName} (${item.riderId})`,
          );
        return;
      }
      const tr = e.target.closest("tr[data-rr-id]");
      if (tr && !e.target.closest("button, a, input, select, textarea"))
        viewDetail(tr.dataset.rrId);
    });
    $("#rrRows").addEventListener("keydown", (e) => {
      if (
        (e.key === "Enter" || e.key === " ") &&
        e.target.matches("tr[data-rr-id]")
      ) {
        e.preventDefault();
        viewDetail(e.target.dataset.rrId);
      }
    });
    $("#rrAdd").addEventListener("click", openAddForm);
    $("#rrOpenFromRiders")?.addEventListener("click", openAddForm);
    $("#rrModalClose").addEventListener("click", closeModal);
    $("#rrModal").addEventListener("click", (e) => {
      if (e.target.id === "rrModal") closeModal();
    });
    document
      .querySelector('.nav[data-page="riderApps"]')
      ?.addEventListener("click", () => load());
    // Refresh while this page is open (not while a dialog is open), and when coming back to the tab.
    const visible = () =>
      !document.hidden &&
      !$("#riderApps").classList.contains("hidden") &&
      !document.querySelector(".modal:not(.hidden)");
    setInterval(() => {
      if (visible()) load({ quiet: true });
    }, 60000);
    document.addEventListener("visibilitychange", () => {
      if (visible()) load({ quiet: true });
    });
  }

  // Start the page's data once the partner is signed in (app.js shows the portal after sign-in).
  const wait = setInterval(() => {
    if (typeof PORTAL === "undefined" || !document.getElementById("app"))
      return;
    clearInterval(wait);
    bind();
    // Load the list after sign-in: a quiet attempt every few seconds until the portal is shown.
    const start = setInterval(() => {
      if (!$("#app").classList.contains("hidden")) {
        clearInterval(start);
        load({ quiet: true });
      }
    }, 1000);
  }, 200);
})();
