// Vendor Portal: each partner signs in with the login created when On The Way Logistics accepted their
// application. Their profile, locations, riders, orders and photo are saved on the server under
// their own account, so they see the same data on any device and nobody else can see it.
const PORTAL = "vendor",
  PORTAL_NAME = "Vendor Portal";
const API_BASE =
  window.OTW_API_BASE ||
  (location.protocol === "file:" ? "http://localhost:8080" : "");
let data = null,
  saveTimer = null,
  knownPassword = "",
  firstPasswordChange = false,
  vendorWeeklyPayments = [],
  weeklyPaymentPage = 1;
const $ = (s) => document.querySelector(s),
  $$ = (s) => document.querySelectorAll(s);
// Older demo versions kept data in this browser; it is no longer used.
try {
  [
    "ontheway_franchise_demo_v1",
    "ontheway_vendor_portal_v1",
    "ontheway_franchise_portal_v1",
  ].forEach((k) => localStorage.removeItem(k));
} catch (e) {}
async function api(path, { method = "GET", body } = {}) {
  const r = await fetch(API_BASE + path, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let out = {};
  try {
    out = await r.json();
  } catch (e) {}
  if (r.status === 401 && data && !path.startsWith("/api/auth/"))
    sessionEnded();
  return { ok: r.ok, status: r.status, ...out };
}
function portalToast(msg, isError) {
  let t = $("#portalToast");
  if (!t) {
    t = document.createElement("div");
    t.id = "portalToast";
    t.setAttribute("role", "status");
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = isError ? "show error" : "show";
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.className = ""), isError ? 6000 : 2200);
}
// Saves shortly after each change (several quick changes are sent together).
function save() {
  if (!data) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}
async function saveNow() {
  saveTimer = null;
  try {
    const out = await api("/api/portal/data?portal=" + PORTAL, {
      method: "PUT",
      body: { data },
    });
    if (!out.ok) throw new Error(out.error || "Not saved");
  } catch (err) {
    portalToast(
      "Your last change was not saved: " +
        (err.message === "Failed to fetch"
          ? "no connection to the server."
          : err.message),
      true,
    );
  }
}
window.addEventListener("beforeunload", () => {
  if (saveTimer && data) {
    clearTimeout(saveTimer);
    try {
      fetch(API_BASE + "/api/portal/data?portal=" + PORTAL, {
        method: "PUT",
        credentials: "include",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data }),
      });
    } catch (e) {}
  }
});
function showLogin(message = "") {
  data = null;
  window.OTWSupportTracker?.reset();
  $("#app").classList.add("hidden");
  $("#loginPage").classList.remove("hidden");
  $("#loginError").textContent = message;
}
function sessionEnded() {
  closePasswordModal();
  showLogin("Your session has ended. Please sign in again.");
}
async function enterPortal() {
  const out = await api("/api/portal/data?portal=" + PORTAL);
  if (!out.ok) {
    if (out.code === "PASSWORD_CHANGE_REQUIRED") {
      openPasswordModal(true);
      return;
    }
    showLogin(
      out.status === 401 ? "" : out.error || "Could not load your account.",
    );
    return;
  }
  applyServerData(out.data);
  $("#loginPage").classList.add("hidden");
  $("#app").classList.remove("hidden");
  populate();
  window.startPartnerLocations?.();
  loadNotifications();
  loadVendorWeeklyPayments(true);
  // The support panel was drawn before sign-in: load this partner's tickets now.
  window.OTWSupportTracker?.refresh();
  if (!$("#supportName").value)
    $("#supportName").value = data.contact || data.name || "";
  if (!$("#supportEmail").value) $("#supportEmail").value = data.email || "";
  if (!$("#supportPhone").value) $("#supportPhone").value = data.phone || "";
}
// Choose a password on first sign-in (replacing the temporary one), or change it later from Settings.
function openPasswordModal(first) {
  firstPasswordChange = !!first;
  $("#pwForm").reset();
  $("#pwMessage").textContent = "";
  $("#pwTitle").textContent = first
    ? "Welcome! Choose your password"
    : "Change password";
  $("#pwIntro").textContent = first
    ? "This is your first sign-in. Replace the temporary password with your own. Use at least 8 characters with letters and numbers."
    : "Use at least 8 characters with letters and numbers. Other devices will be signed out.";
  const needCurrent = !(first && knownPassword);
  $("#pwCurrentWrap").classList.toggle("hidden", !needCurrent);
  $("#pwCurrent").required = needCurrent;
  $("#pwModal").classList.remove("hidden");
  (needCurrent ? $("#pwCurrent") : $("#pwNew")).focus();
}
function closePasswordModal() {
  $("#pwModal").classList.add("hidden");
}

function populate() {
  clearFieldErrors($("#profile"));
  renderSelfieAvatars();
  if (!Array.isArray(data.riders)) data.riders = [];
  ["sideName", "topName"].forEach(
    (id) =>
      ($("#" + id).textContent = (data.contact || "").trim() || data.name),
  );
  ["sideId", "topId", "badgeId", "pId"].forEach((id) => {
    const el = $("#" + id);
    if (el)
      el.value !== undefined
        ? (el.value = data.id)
        : (el.textContent = data.id);
  });
  $("#pName").value = data.name;
  $("#pContact").value = data.contact;
  $("#pPhone").value = cleanMobile(data.phone) || data.phone;
  $("#pEmail").value = data.email;
  $("#pState").value = data.state;
  $("#pDistrict").value = data.district;
  $("#pCity").value = data.city;
  $("#pPin").value = data.pin;
  $("#pOffice").value = data.office;
  $("#pAddress").value = data.address;
  $("#pRemarks").value = data.remarks;
  renderRiders();
  renderReports();
  renderRecent();
}
// My Locations is drawn by partner-locations.js (shared by both portals).
// ---------- Reports: every figure comes from the server report built from the same saved rows as Orders ----------
// portalReport is set by the shared weekly-payments request (the same one that fills the Orders table).
// The Week selector picks one saved weekly period; by default the newest one is shown.
let portalReport = null,
  reportWeekKey = "";
const setText = (sel, v) => {
  const el = $(sel);
  if (el) el.textContent = v;
};
function renderWeekOptions(r) {
  const sel = $("#reportWeek");
  if (!sel) return;
  const weeks = r?.weeks || [],
    sig = weeks.map((w) => w.key).join("|");
  if (sel.dataset.sig !== sig) {
    sel.innerHTML = weeks.length
      ? weeks
          .map((w) => `<option value="${esc(w.key)}">${esc(w.label)}</option>`)
          .join("")
      : '<option value="">No weekly records</option>';
    sel.dataset.sig = sig;
  }
  if (r?.weekly?.key) sel.value = r.weekly.key;
}
$("#reportWeek")?.addEventListener("change", (e) => {
  reportWeekKey = e.target.value;
  loadVendorWeeklyPayments(true);
});
function renderReports() {
  const r = portalReport,
    n = (v) => Number(v) || 0;
  setText("#reportRiders", n(r?.riders?.total));
  setText("#reportActiveRiders", n(r?.riders?.withOrders));
  setText("#reportLocations", n(r?.locations));
  setText("#reportOrders", n(r?.allTimeOrders));
  setText("#statOrders", n(r?.allTimeOrders));
  // Weekly Order Summary: the selected weekly cycle (same Week label the Orders page shows).
  const w = r?.weekly;
  renderWeekOptions(r);
  setText("#weeklyPeriod", w ? w.label : "No weekly records yet");
  setText("#weeklyTotal", n(w?.total));
  setText("#weeklyPrimary", n(w?.primary));
  setText("#weeklyClub", n(w?.club));
  setText("#weeklyLarge", n(w?.large));
  const weeklyItems = [
    {
      label: "Primary",
      value: n(w?.primary),
      cls: "primary-bar",
      name: "Prime Orders",
    },
    { label: "Club", value: n(w?.club), cls: "club-bar", name: "Club Orders" },
    { label: "Large", value: n(w?.large), cls: "large-bar", name: "LM Orders" },
    { label: "SDD", value: n(w?.sdd), cls: "sdd-bar", name: "SDD Orders" },
  ];
  const weeklyMax = Math.max(1, ...weeklyItems.map((x) => x.value));
  $("#weeklyChart").innerHTML =
    `<div class="weekly-column-chart">${weeklyItems.map((x) => `<div class="weekly-column-item" title="${x.name}: ${x.value}"><div class="weekly-column-value">${x.value}</div><div class="weekly-column-track"><div class="weekly-column-fill ${x.cls}" style="height:${x.value ? Math.max(3, (x.value / weeklyMax) * 100) : 0}%"></div></div><b>${x.label}</b></div>`).join("")}</div><div class="chart-legend"><span><i class="legend-primary"></i>Primary</span><span><i class="legend-club"></i>Club</span><span><i class="legend-large"></i>Large</span><span><i class="legend-sdd"></i>SDD</span></div><p class="muted">Total orders this week: ${n(w?.total)}</p>`;
  // 15-Day Performance Report: the newest 15-day cycle, then one row per saved 15-day period.
  const c = r?.cycle15;
  setText("#cyclePeriod", c ? c.label : "No 15-day records yet");
  setText("#cycleTotal", n(c?.total));
  setText("#cyclePrimary", n(c?.primary));
  setText("#cycleClub", n(c?.club));
  setText("#cycleLarge", n(c?.large));
  const periods = r?.periods15 || [];
  const chart = periods.slice(0, 15).reverse(); // newest 15, oldest first
  const maxP = Math.max(
    1,
    ...chart.flatMap((p) => [p.primary, p.club, p.large]),
  );
  $("#cycleChart").innerHTML = chart.length
    ? chart
        .map(
          (p) =>
            `<div class="cycle-day" title="${esc(p.label)} — Primary: ${p.primary}, Club: ${p.club}, Large: ${p.large}, SDD: ${p.sdd}, Total: ${p.total}"><div class="cycle-bars"><div class="cycle-series-bar primary-bar" style="height:${p.primary ? Math.max(2, (p.primary / maxP) * 100) : 0}%"></div><div class="cycle-series-bar club-bar" style="height:${p.club ? Math.max(2, (p.club / maxP) * 100) : 0}%"></div><div class="cycle-series-bar large-bar" style="height:${p.large ? Math.max(2, (p.large / maxP) * 100) : 0}%"></div></div><span>${esc(String(p.start || "").slice(8, 10) || "—")}</span></div>`,
        )
        .join("") +
      `<div class="chart-legend cycle-legend"><span><i class="legend-primary"></i>Primary</span><span><i class="legend-club"></i>Club</span><span><i class="legend-large"></i>Large</span></div>`
    : '<p class="muted">No 15-day records yet.</p>';
  $("#cycleTable").innerHTML = periods.length
    ? periods
        .map(
          (p) =>
            `<tr><td>${esc(p.label)}</td><td>${p.riders}</td><td>${p.primary}</td><td>${p.club}</td><td>${p.large}</td><td>${p.sdd}</td><td><b>${p.total}</b></td></tr>`,
        )
        .join("")
    : '<tr><td colspan="7">No 15-day records yet.</td></tr>';
  const sum = (k) => periods.reduce((a, p) => a + n(p[k]), 0);
  $("#cycleTotals").innerHTML = periods.length
    ? `<tr><th>Total</th><th>—</th><th>${sum("primary")}</th><th>${sum("club")}</th><th>${sum("large")}</th><th>${sum("sdd")}</th><th>${sum("total")}</th></tr>`
    : "";
}

// Dashboard recent locations are drawn by partner-locations.js.
function renderRecent() {}
function esc(v) {
  return String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
function showPage(name) {
  $(".sidebar")?.classList.remove("open"); // on phones, close the menu after choosing a page
  $$(".page").forEach((p) => p.classList.add("hidden"));
  $("#" + name).classList.remove("hidden");
  $$(".nav").forEach((n) =>
    n.classList.toggle("active", n.dataset.page === name),
  );
  const titles = {
    orders: "Orders",
    dashboard: "Dashboard",
    profile: "Vendor Profile",
    locations: "My Locations",
    riders: "Riders",
    riderApps: "Rider Applications",
    reports: "Reports",
    notifications: "Notifications",
    settings: "Settings",
  };
  $("#pageTitle").textContent = titles[name] || name;
}
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector("button[type=submit]"),
    loginId = $("#loginId").value.trim(),
    pw = $("#password").value;
  $("#loginError").textContent = "";
  if (!loginId || !pw) return;
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    const out = await api("/api/auth/login", {
      method: "POST",
      body: { portal: PORTAL, loginId, password: pw },
    });
    if (!out.ok) {
      $("#loginError").textContent = out.error || "Could not sign in.";
      return;
    }
    $("#password").value = "";
    if (out.account.mustChangePassword) {
      knownPassword = pw;
      openPasswordModal(true);
      return;
    }
    await enterPortal();
  } catch (err) {
    $("#loginError").textContent =
      "Cannot reach the server. Please check your connection and try again.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign In";
  }
});
$("#pwForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const m = $("#pwMessage"),
    np = $("#pwNew").value;
  m.textContent = "";
  if (np !== $("#pwConfirm").value) {
    m.textContent = "The two new passwords do not match.";
    return;
  }
  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    const out = await api("/api/auth/change-password", {
      method: "POST",
      body: {
        portal: PORTAL,
        currentPassword:
          firstPasswordChange && knownPassword
            ? knownPassword
            : $("#pwCurrent").value,
        newPassword: np,
      },
    });
    if (!out.ok) {
      m.textContent = out.error || "Could not change the password.";
      if (out.status === 401) {
        closePasswordModal();
        showLogin("Please sign in again.");
      }
      return;
    }
    knownPassword = "";
    closePasswordModal();
    if (firstPasswordChange) {
      await enterPortal();
      portalToast("Password saved. Welcome to the " + PORTAL_NAME + "!");
    } else portalToast("Password changed");
  } catch (err) {
    m.textContent = "Cannot reach the server. Please try again.";
  } finally {
    btn.disabled = false;
  }
});
$("#pwClose").onclick = async () => {
  if (firstPasswordChange) {
    knownPassword = "";
    await api("/api/auth/logout", {
      method: "POST",
      body: { portal: PORTAL },
    }).catch(() => {});
    closePasswordModal();
    showLogin("You need to choose a password before you can continue.");
  } else closePasswordModal();
};
$("#changePwBtn").onclick = () => openPasswordModal(false);
$("#showPass").onclick = () => {
  $("#password").type =
    $("#password").type === "password" ? "text" : "password";
  $("#showPass").textContent =
    $("#password").type === "password" ? "Show" : "Hide";
};
$$(".nav").forEach((n) => (n.onclick = () => showPage(n.dataset.page)));
$$("[data-page-jump]").forEach(
  (b) => (b.onclick = () => showPage(b.dataset.pageJump)),
);
$("#logout").onclick = async () => {
  clearTimeout(saveTimer);
  if (data) await saveNow();
  await api("/api/auth/logout", {
    method: "POST",
    body: { portal: PORTAL },
  }).catch(() => {});
  location.reload();
};
$("#menu").onclick = () => $(".sidebar").classList.toggle("open");
$("#riderSearch").oninput = renderRiders;
$("#addRider").onclick = () => openRiderModal("");
$("#closeRiderModal").onclick = () => {
  $("#riderModal").classList.add("hidden");
  discardPendingShot();
};
const PROFILE_FIELDS = [
  "pName",
  "pContact",
  "pPhone",
  "pEmail",
  "pState",
  "pDistrict",
  "pCity",
  "pPin",
  "pAddress",
];
function readProfileForm() {
  data.name = $("#pName").value.trim() || data.name;
  data.contact = $("#pContact").value.trim();
  data.phone = $("#pPhone").value.trim();
  data.email = $("#pEmail").value.trim();
  data.state = $("#pState").value.trim();
  data.district = $("#pDistrict").value.trim();
  data.city = $("#pCity").value.trim();
  data.pin = $("#pPin").value.trim();
  data.office = $("#pOffice").value.trim();
  data.address = $("#pAddress").value.trim();
  data.remarks = $("#pRemarks").value.trim();
}
$("#saveProfile").onclick = () => {
  if (!validateFields(PROFILE_FIELDS)) return;
  readProfileForm();
  save();
  populate();
  alert("Vendor profile updated successfully.");
};
$("#submitProfile").onclick = () => {
  if (!validateFields(PROFILE_FIELDS, PROFILE_FIELDS)) return;
  readProfileForm();
  data.profileSubmittedAt = new Date().toISOString();
  data.profileSubmissionStatus = "Submitted";
  save();
  populate();
  alert("Vendor profile submitted successfully!");
};
// Stay signed in across visits.
(async () => {
  try {
    const out = await api("/api/auth/me?portal=" + PORTAL);
    if (!out.ok) return;
    if (out.account.mustChangePassword) {
      openPasswordModal(true);
      return;
    }
    await enterPortal();
  } catch (e) {}
})();

// Profile selfie (camera only). The photo is cropped to a square, the same area the round guide shows,
// and saved with this account's portal data.
let selfieStream = null,
  selfieCapturedDataUrl = null;
const selfieModal = $("#selfieModal"),
  selfieVideo = $("#selfieVideo"),
  selfieCanvas = $("#selfieCanvas");
function renderSelfieAvatars() {
  $$(".avatar-trigger").forEach((btn) => {
    btn.replaceChildren();
    if (data.selfieDataUrl) {
      const img = document.createElement("img");
      img.src = data.selfieDataUrl;
      img.alt =
        "Selfie of " +
        (data.selfiePersonName || data.contact || data.name || "account user");
      btn.appendChild(img);
    } else btn.textContent = "V";
  });
  const visibleName =
    (data.selfieDataUrl && (data.selfiePersonName || "").trim()) ||
    (data.contact || "").trim() ||
    data.name ||
    "Vendor Partner";
  ["sideName", "topName"].forEach((id) => {
    const el = $("#" + id);
    if (el) el.textContent = visibleName;
  });
}
function selfieNote(text) {
  $("#selfieFrameNote").textContent = text || "";
}
function selfieMessage(text, isError) {
  const m = $("#selfieMessage");
  m.textContent = text || "";
  m.classList.toggle("error", !!isError);
}
function stopSelfieCamera() {
  if (selfieStream) {
    selfieStream.getTracks().forEach((track) => track.stop());
    selfieStream = null;
  }
  selfieVideo.srcObject = null;
}
function showSelfieStep(step) {
  const review = step === "review";
  selfieVideo.classList.toggle("hidden", review);
  selfieCanvas.classList.toggle("hidden", !review);
  $("#selfieCapture").classList.toggle("hidden", review);
  $("#selfieRetake").classList.toggle("hidden", !review);
  $("#selfieSave").classList.toggle("hidden", !review);
}
function resetSelfieModal() {
  selfieCapturedDataUrl = null;
  showSelfieStep("live");
  $("#selfieCapture").disabled = !selfieStream;
  selfieNote("");
  selfieMessage("");
}
function cameraProblem(err) {
  if (err && err.name === "NotAllowedError")
    return "Camera permission was denied. Allow camera access for this site in your browser (the camera icon in the address bar) and try again.";
  if (err && err.name === "NotFoundError")
    return "No camera was found on this device.";
  if (err && err.name === "NotReadableError")
    return "The camera is being used by another app (for example Zoom, Teams or the Camera app). Close it and try again.";
  return (
    (err && err.message) ||
    "Unable to open the camera. Check your camera connection and browser permissions."
  );
}
async function openSelfieCamera() {
  stopSelfieCamera();
  resetSelfieModal();
  const nameInput = $("#selfiePersonName");
  nameInput.value = (data.selfiePersonName || data.contact || "").trim();
  clearFieldErrors(selfieModal);
  selfieModal.classList.remove("hidden");
  if (!nameInput.value) nameInput.focus();
  selfieNote("Starting camera…");
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
      throw new Error(
        "Camera access is unavailable. Open this site over HTTPS or localhost and try again.",
      );
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "user" } },
      audio: false,
    });
    if (selfieModal.classList.contains("hidden")) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    } // closed while the camera was starting
    selfieStream = stream;
    selfieVideo.srcObject = stream;
    selfieVideo.classList.add("mirrored");
    await selfieVideo.play();
    selfieNote("");
    $("#selfieCapture").disabled = false;
  } catch (err) {
    stopSelfieCamera();
    selfieNote("Camera not available");
    selfieMessage(cameraProblem(err), true);
    $("#selfieCapture").classList.add("hidden");
  }
}
$$(".avatar-trigger").forEach((btn) =>
  btn.addEventListener("click", openSelfieCamera),
);
$("#selfieCapture").addEventListener("click", () => {
  const vw = selfieVideo.videoWidth,
    vh = selfieVideo.videoHeight;
  if (!vw || !vh) {
    selfieMessage(
      "Camera preview is not ready yet. Please wait a moment.",
      true,
    );
    return;
  }
  const side = Math.min(vw, vh),
    out = Math.min(side, 640);
  selfieCanvas.width = out;
  selfieCanvas.height = out;
  const ctx = selfieCanvas.getContext("2d");
  ctx.translate(out, 0);
  ctx.scale(-1, 1); // same mirror view as the live preview
  ctx.drawImage(
    selfieVideo,
    (vw - side) / 2,
    (vh - side) / 2,
    side,
    side,
    0,
    0,
    out,
    out,
  );
  selfieCapturedDataUrl = shrinkSelfie(selfieCanvas);
  showSelfieStep("review");
  selfieMessage("Happy with it? Choose Save Selfie, or Retake.");
});
$("#selfieRetake").addEventListener("click", () => {
  resetSelfieModal();
  if (selfieStream) selfieVideo.play().catch(() => {});
});
$("#selfieSave").addEventListener("click", () => {
  if (!selfieCapturedDataUrl) return;
  const takerName = $("#selfiePersonName").value.replace(/\s+/g, " ").trim();
  if (!takerName) {
    selfieMessage(
      "Please enter the name of the person taking the selfie.",
      true,
    );
    $("#selfiePersonName").focus();
    return;
  }
  {
    const p = fieldProblem($("#selfiePersonName"));
    if (p) {
      selfieMessage(p, true);
      $("#selfiePersonName").focus();
      return;
    }
  }
  data.selfiePersonName = takerName;
  data.selfieDataUrl = selfieCapturedDataUrl;
  save();
  renderSelfieAvatars();
  closeSelfieModal();
});
function closeSelfieModal() {
  stopSelfieCamera();
  selfieModal.classList.add("hidden");
  resetSelfieModal();
}
$("#selfieCancel").addEventListener("click", closeSelfieModal);
$("#selfieClose").addEventListener("click", closeSelfieModal);
selfieModal.addEventListener("click", (e) => {
  if (e.target === selfieModal) closeSelfieModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !selfieModal.classList.contains("hidden"))
    closeSelfieModal();
});

// Show the support address the server really sends to (SUPPORT_EMAIL in backend/.env).
(async () => {
  const el = document.getElementById("supportAddress");
  if (!el) return;
  try {
    const base = window.OTW_API_BASE || (location.protocol === "file:" ? "http://localhost:8080" : "");
    const out = await (await fetch(base + "/api/support-info")).json();
    if (out && out.email) {
      el.href = "mailto:" + out.email;
      el.innerHTML = "<b></b>";
      el.firstChild.textContent = out.email;
    }
  } catch (e) {}
})();
// Helpline / Support: photo and details are delivered by the companion server endpoint.
// One id per submission: sending the same request again returns the same ticket instead of creating a second one.
const newSupportId = () =>
  (window.crypto && crypto.randomUUID && crypto.randomUUID()) ||
  "sub-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
let supportSubmissionId = newSupportId();
const supportForm = $("#supportForm");
if (supportForm) {
  supportForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = $("#supportStatus"),
      submit = $("#supportSubmit"),
      name = $("#supportName").value.replace(/\s+/g, " ").trim(),
      email = $("#supportEmail").value.trim(),
      description = $("#supportDescription").value.trim(),
      photo = $("#supportPhoto").files[0];
    status.className = "support-status support-wide";
    status.textContent = "";
    if (!name || !email || !description || !photo) {
      status.classList.add("error");
      status.textContent =
        "Please complete your name, valid email address, problem description, and attach a photo.";
      return;
    }
    if (!$("#supportEmail").checkValidity()) {
      status.classList.add("error");
      status.textContent = "Please enter a valid email address.";
      $("#supportEmail").focus();
      return;
    }
    if (!validateFields(["supportName", "supportPhone"])) {
      status.classList.add("error");
      status.textContent = "Please correct the highlighted fields.";
      return;
    }
    if (!photo.type || !photo.type.startsWith("image/")) {
      status.classList.add("error");
      status.textContent = "Please attach an image file for the problem.";
      return;
    }
    const formData = new FormData();
    formData.append("name", name);
    formData.append("email", email);
    formData.append("phone", $("#supportPhone").value.trim());
    formData.append("description", description);
    formData.append("photo", photo, photo.name);
    formData.append("submissionId", supportSubmissionId);
    submit.disabled = true;
    submit.textContent = "Submitting…";
    try {
      formData.append("portal", "Vendor Portal");
      formData.append("partnerId", data.id || "");
      const apiBase =
        window.OTW_API_BASE ||
        (location.protocol === "file:" ? "http://localhost:8080" : "");
      const response = await fetch(apiBase + "/api/support", {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      let result = {};
      try {
        result = await response.json();
      } catch {}
      if (!response.ok)
        throw new Error(
          result.error ||
            "The support email could not be sent. Please try again later.",
        );
      status.classList.add("success");
      status.textContent =
        result.message ||
        "Your issue has been submitted. Our support team will contact you soon.";
      supportSubmissionId = newSupportId();
      supportForm.reset();
      if (window.OTWSupportTracker) window.OTWSupportTracker.refresh();
    } catch (err) {
      status.classList.add("error");
      status.textContent =
        (location.protocol === "file:"
          ? "Please run this website using the included server setup; direct file opening cannot send support email. "
          : "") +
        (err.message ||
          "Unable to submit your issue. Please check your connection and try again.");
    } finally {
      submit.disabled = false;
      submit.textContent = "Submit Issue";
    }
  });
}

function shrinkSelfie(c) {
  const max = 320,
    k = Math.min(1, max / Math.max(c.width, c.height));
  const o = document.createElement("canvas");
  o.width = Math.round(c.width * k);
  o.height = Math.round(c.height * k);
  o.getContext("2d").drawImage(c, 0, 0, o.width, o.height);
  return o.toDataURL("image/jpeg", 0.85);
}

// ---------- Refresh: load the latest orders / riders from the server ----------
let refreshing = false,
  lastSync = null;
function applyServerData(d) {
  data = d;
  ["locations", "riders", "orderRecords", "applications"].forEach((k) => {
    if (!Array.isArray(data[k])) data[k] = [];
  });
  lastSync = new Date();
  showLastSync();
}
function showLastSync() {
  $$("[data-last-sync]").forEach(
    (el) =>
      (el.textContent = lastSync
        ? "Updated " +
          lastSync.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })
        : ""),
  );
}
// Redraws the lists, totals and reports only; profile fields are left alone so nothing being typed is lost.
function renderLists() {
  renderSelfieAvatars();
  renderRiders();
  renderReports();
  renderRecent();
}
async function refreshData({ quiet = false, button = null } = {}) {
  if (!data || refreshing) return;
  refreshing = true;
  const label = button ? button.innerHTML : "";
  if (button) {
    button.disabled = true;
    button.textContent = "Refreshing…";
  }
  try {
    if (saveTimer) {
      clearTimeout(saveTimer);
      await saveNow();
    } // send your own unsaved change first
    const out = await api("/api/portal/data?portal=" + PORTAL);
    if (!out.ok) {
      if (out.status !== 401 && !quiet)
        portalToast(out.error || "Could not refresh.", true);
      return;
    }
    applyServerData(out.data);
    renderLists();
    loadVendorWeeklyPayments(true);
    if (!quiet) portalToast("Up to date");
  } catch (e) {
    if (!quiet)
      portalToast("Could not refresh: no connection to the server.", true);
  } finally {
    refreshing = false;
    if (button) {
      button.disabled = false;
      button.innerHTML = label;
    }
  }
}
$$("[data-refresh]").forEach((b) =>
  b.addEventListener("click", () => refreshData({ button: b })),
);
// Also refresh by itself every minute while the portal is open, and when you come back to this tab.
// Skipped while a dialog is open or a change is still being saved, so nothing you are typing is lost.
const refreshBusy = () =>
  document.hidden ||
  !!saveTimer ||
  !!document.querySelector(".modal:not(.hidden)");
setInterval(() => {
  if (data && !refreshBusy()) refreshData({ quiet: true });
}, 60000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && data && !refreshBusy()) refreshData({ quiet: true });
});

// ---------- Location URL (e.g. a Google Maps link) ----------
// Returns a cleaned https/http link, '' when the box is empty, or null when it is not a usable web link.
function cleanLocationUrl(value) {
  let v = String(value || "").trim();
  if (!v) return "";
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = "https://" + v; // "maps.app.goo.gl/abc" -> "https://maps.app.goo.gl/abc"
  try {
    const u = new URL(v);
    if (!["http:", "https:"].includes(u.protocol) || !u.hostname.includes("."))
      return null;
    return u.href.slice(0, 500);
  } catch (e) {
    return null;
  }
}
// Only real web links become clickable; anything else is not shown.
function locationLink(url) {
  const u = cleanLocationUrl(url);
  return u
    ? `<a class="location-link" href="${esc(u)}" target="_blank" rel="noopener noreferrer" title="${esc(u)}">Open map ↗</a>`
    : '<span class="muted">—</span>';
}

// ---------- Riders: details + documents (screenshot, Aadhaar) ----------
// Documents are uploaded to the server and can only be opened by this signed-in partner.
const RIDER_DOCS = [
  {
    kind: "screenshot",
    field: "screenshotFile",
    input: "#rScreenshot",
    info: "#rScreenshotCurrent",
    label: "Screenshot",
    name: "screenshot",
    types: ["image/jpeg", "image/png", "image/webp"],
    hint: "JPG, PNG or WEBP image, up to 5 MB.",
  },
  {
    kind: "aadhaar",
    field: "aadhaarFile",
    input: "#rAadhaar",
    info: "#rAadhaarCurrent",
    label: "Aadhaar",
    name: "Aadhaar",
    types: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
    hint: "Photo or PDF of the Aadhaar card, up to 5 MB. A masked Aadhaar (only the last 4 digits visible) is recommended.",
  },
];
const MAX_UPLOAD = 5 * 1024 * 1024;
const fileUrl = (f) =>
  `${API_BASE}/api/portal/files/${encodeURIComponent(f.id)}?portal=${PORTAL}`;
function docLink(f, label) {
  return f && f.id
    ? `<a class="doc-link" href="${esc(fileUrl(f))}" target="_blank" rel="noopener" title="${esc(f.name || label)}">${label} ↗</a>`
    : `<span class="doc-missing">${label} missing</span>`;
}
function renderRiders() {
  const el = $("#riderTable");
  if (!el) return;
  const q = ($("#riderSearch")?.value || "").toLowerCase();
  const rows = (data.riders || []).filter((r) =>
    [r.id, r.name, r.phone, r.hubPincode, r.hubLocation]
      .join(" ")
      .toLowerCase()
      .includes(q),
  );
  el.innerHTML =
    rows
      .map(
        (r) =>
          `<tr><td><b>${esc(r.id)}</b></td><td>${esc(r.name)}</td><td>${esc(r.phone)}</td><td>${esc(r.hubPincode || "—")}</td><td>${esc(r.hubLocation || "—")}</td><td class="doc-cell">${docLink(r.screenshotFile, "Screenshot")}${docLink(r.aadhaarFile, "Aadhaar")}</td><td><button class="link" type="button" data-id="${esc(r.id)}" onclick="editRider(encodeURIComponent(this.dataset.id))">Edit</button> <button class="member-delete" type="button" data-id="${esc(r.id)}" onclick="removeRider(encodeURIComponent(this.dataset.id))">Remove</button></td></tr>`,
      )
      .join("") ||
    '<tr><td colspan="7">No riders found. Click “Add Rider” to create the first rider.</td></tr>';
}
function openRiderModal(id) {
  clearFieldErrors($("#riderForm"));
  const rider = (data.riders || []).find((r) => r.id === id);
  discardPendingShot();
  $("#riderForm").reset();
  $("#riderFormError").textContent = "";
  resetAutofill();
  $("#rOriginalId").value = rider ? rider.id : "";
  $("#rId").value = rider ? rider.id : "";
  $("#rId").disabled = !!rider;
  $("#rName").value = rider?.name || "";
  $("#rPhone").value = rider?.phone || "";
  $("#rHubPin").value = rider?.hubPincode || "";
  $("#rHubLocation").value = rider?.hubLocation || "";
  for (const d of RIDER_DOCS) {
    const f = rider?.[d.field];
    $(d.info).innerHTML =
      f && f.id
        ? `Current: <a href="${esc(fileUrl(f))}" target="_blank" rel="noopener">${esc(f.name || d.label)}</a>. Choose a new file only to replace it.`
        : esc(d.hint);
  }
  $("#riderModalTitle").textContent = rider ? "Edit Rider" : "Add Rider";
  $("#riderModal").classList.remove("hidden");
  $(rider ? "#rName" : "#rId").focus();
}
function editRider(id) {
  openRiderModal(decodeURIComponent(id));
}
window.editRider = editRider;
async function uploadFile(kind, file) {
  const fd = new FormData();
  fd.append("kind", kind);
  fd.append("file", file, file.name);
  const r = await fetch(`${API_BASE}/api/portal/files?portal=${PORTAL}`, {
    method: "POST",
    credentials: "include",
    body: fd,
  });
  let out = {};
  try {
    out = await r.json();
  } catch (e) {}
  if (r.status === 401) {
    sessionEnded();
    throw new Error("Please sign in again.");
  }
  if (!r.ok) throw new Error(out.error || "Upload failed.");
  return out;
}
const deleteFile = (id) =>
  api(`/api/portal/files/${encodeURIComponent(id)}?portal=${PORTAL}`, {
    method: "DELETE",
  }).catch(() => {});
async function saveRidersNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const out = await api("/api/portal/data?portal=" + PORTAL, {
    method: "PUT",
    body: { data },
  });
  if (!out.ok) throw new Error(out.error || "Could not save.");
}
async function removeRider(id) {
  id = decodeURIComponent(id);
  const r = (data.riders || []).find((x) => x.id === id);
  if (
    !r ||
    !confirm(`Remove rider ${r.name || r.id} and their uploaded documents?`)
  )
    return;
  const before = data.riders;
  data.riders = data.riders.filter((x) => x.id !== id);
  try {
    await saveRidersNow();
  } catch (e) {
    data.riders = before;
    portalToast("Rider not removed: " + e.message, true);
    return;
  }
  for (const d of RIDER_DOCS) if (r[d.field]?.id) deleteFile(r[d.field].id);
  renderLists();
  portalToast("Rider removed");
}
window.removeRider = removeRider;
// Mobile numbers are stored as 10 digits ("+91 98765 43210" and "098765 43210" are accepted).
function cleanMobile(v) {
  let d = String(v || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : "";
}
$("#riderForm").onsubmit = async (e) => {
  e.preventDefault();
  const err = (msg, sel) => {
    const el = sel && $(sel);
    if (el && FIELD_RULES[el.id]) showFieldError(el, msg);
    else $("#riderFormError").textContent = msg;
    if (el) el.focus();
  };
  $("#riderFormError").textContent = "";
  clearFieldErrors($("#riderForm"));
  const original = $("#rOriginalId").value.trim(),
    id = $("#rId").value.trim(),
    name = $("#rName").value.replace(/\s+/g, " ").trim(),
    phone = $("#rPhone").value.trim(),
    hubPincode = $("#rHubPin").value.trim(),
    hubLocation = $("#rHubLocation").value.trim();
  const existing = original ? data.riders.find((r) => r.id === original) : null;
  if (!/^.{2,40}$/.test(id))
    return err("Enter the Rider ID / Partner ID (2 to 40 characters).", "#rId");
  if (
    !original &&
    data.riders.some((r) => r.id.toLowerCase() === id.toLowerCase())
  )
    return err(
      "A rider with this Rider ID / Partner ID already exists.",
      "#rId",
    );
  if (!name) return err("Enter the rider name.", "#rName");
  {
    const p = fieldProblem($("#rName"));
    if (p) return err(p, "#rName");
  }
  if (!/^\d{10}$/.test(phone))
    return err("Enter a 10-digit mobile number (digits only).", "#rPhone");
  if (!/^[6-9]/.test(phone))
    return err("Mobile numbers start with 6, 7, 8 or 9.", "#rPhone");
  if (!/^[1-9]\d{5}$/.test(hubPincode))
    return err("Enter the 6-digit hub pincode.", "#rHubPin");
  if (!hubLocation) return err("Enter the hub location.", "#rHubLocation");
  const chosen = {};
  for (const d of RIDER_DOCS) {
    const f = $(d.input).files[0];
    if (!f && !existing?.[d.field]?.id)
      return err(
        `Upload the ${d.name} ${d.kind === "aadhaar" ? "(image or PDF)" : "image"}.`,
        d.input,
      );
    if (f && !d.types.includes(f.type))
      return err(
        d.kind === "aadhaar"
          ? "Aadhaar must be a JPG, PNG or WEBP image, or a PDF."
          : "The screenshot must be a JPG, PNG or WEBP image.",
        d.input,
      );
    if (f && f.size > MAX_UPLOAD)
      return err(`The ${d.name} file is larger than 5 MB.`, d.input);
    if (f) chosen[d.kind] = f;
  }
  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  const before = data.riders.slice(),
    replaced = [],
    uploaded = [];
  try {
    const rider = {
      ...(existing || {}),
      id: original || id,
      name,
      phone,
      hubPincode,
      hubLocation,
    };
    for (const d of RIDER_DOCS)
      if (chosen[d.kind]) {
        btn.textContent = `Uploading ${d.name}…`;
        let up;
        if (
          d.kind === "screenshot" &&
          pendingShot &&
          pendingShot.source === chosen[d.kind]
        ) {
          up = pendingShot.file;
        } else {
          up = (await uploadFile(d.kind, chosen[d.kind])).file;
          uploaded.push(up.id);
        }
        if (existing?.[d.field]?.id) replaced.push(existing[d.field].id);
        rider[d.field] = up;
      }
    btn.textContent = "Saving…";
    if (existing) data.riders[data.riders.indexOf(existing)] = rider;
    else data.riders.push(rider);
    await saveRidersNow();
    replaced.forEach(deleteFile);
    if (pendingShot && rider.screenshotFile?.id === pendingShot.file.id)
      pendingShot.saved = true;
    pendingShot = null;
    $("#riderModal").classList.add("hidden");
    renderLists();
    showPage("riders");
    portalToast(existing ? "Rider updated" : "Rider added");
  } catch (ex) {
    data.riders = before;
    uploaded.forEach(deleteFile);
    err(ex.message || "Could not save the rider.");
  } finally {
    // nothing saved: remove files uploaded in this attempt
    btn.disabled = false;
    btn.textContent = "Save Rider";
  }
};

// ---------- Mobile number: keep exactly 10 digits ----------
// Typing letters or spaces is ignored; pasting "+91 98765 43210" or "098765 43210" keeps the 10-digit number.

// ---------- Fill in Rider ID / name from the delivery-app screenshot ----------
// The screenshot is uploaded as soon as it is chosen; the server reads "Partner ID: 12345678" and the name above it.
// Text reading can misread a character, so filled-in fields are highlighted and the user is asked to check them.
let pendingShot = null,
  shotTicket = 0;
function discardPendingShot() {
  if (pendingShot && !pendingShot.saved) deleteFile(pendingShot.file.id);
  pendingShot = null;
  shotTicket++;
}
function setShotStatus(msg, kind) {
  const el = $("#rShotStatus");
  el.textContent = msg;
  el.className = "autofill-status" + (kind ? " " + kind : "");
}
function markFilled(el, on) {
  if (on) {
    el.dataset.autofilled = "1";
    el.classList.add("autofilled");
  } else {
    delete el.dataset.autofilled;
    el.classList.remove("autofilled");
  }
}
function resetAutofill() {
  for (const el of [$("#rId"), $("#rName")]) markFilled(el, false);
  setShotStatus("");
}
for (const sel of ["#rId", "#rName"])
  $(sel).addEventListener("input", (e) => markFilled(e.target, false)); // typed by hand: no longer "filled in"
function applyScreenshotReading(r) {
  const idEl = $("#rId"),
    nameEl = $("#rName"),
    filled = [],
    id = String(r.partnerId || "");
  if (id) {
    if (idEl.disabled) {
      if (id !== idEl.value.trim())
        return setShotStatus(
          `This screenshot shows Partner ID ${id}, but this rider is ${idEl.value}. Check that you chose the right screenshot.`,
          "warn",
        );
    } else if (!idEl.value.trim() || idEl.dataset.autofilled === "1") {
      idEl.value = id;
      markFilled(idEl, true);
      filled.push("Rider ID / Partner ID");
    } else if (idEl.value.trim() !== id)
      return setShotStatus(
        `The screenshot shows Partner ID ${id}, but ${idEl.value.trim()} is typed above. Please check which is correct.`,
        "warn",
      );
  }
  if (r.name && (!nameEl.value.trim() || nameEl.dataset.autofilled === "1")) {
    nameEl.value = r.name;
    markFilled(nameEl, true);
    filled.push("Rider Name");
  }
  if (filled.length)
    setShotStatus(
      `✓ Filled in ${filled.join(" and ")} from the screenshot (${[id, r.name].filter(Boolean).join(", ")}). Please check ${filled.length > 1 ? "they are" : "it is"} correct.`,
      "ok",
    );
  else if (id) setShotStatus(`✓ Screenshot shows Partner ID ${id}.`, "ok");
  else
    setShotStatus(
      "Couldn't read a Partner ID from this screenshot. Please type the Rider ID / Partner ID above.",
      "warn",
    );
}
$("#rScreenshot").addEventListener("change", async () => {
  const f = $("#rScreenshot").files[0];
  discardPendingShot();
  const ticket = shotTicket;
  for (const el of [$("#rId"), $("#rName")])
    if (el.dataset.autofilled === "1" && !el.disabled) {
      el.value = "";
      markFilled(el, false);
    } // values from a previous screenshot
  if (!f) return setShotStatus("");
  if (!RIDER_DOCS[0].types.includes(f.type))
    return setShotStatus(
      "The screenshot must be a JPG, PNG or WEBP image.",
      "warn",
    );
  if (f.size > MAX_UPLOAD)
    return setShotStatus("The screenshot file is larger than 5 MB.", "warn");
  setShotStatus("Reading the screenshot…", "busy");
  try {
    const out = await uploadFile("screenshot", f);
    if (ticket !== shotTicket) {
      deleteFile(out.file.id);
      return;
    } // a different file was chosen meanwhile
    pendingShot = { file: out.file, source: f, saved: false };
    applyScreenshotReading(out.read || {});
  } catch (e) {
    if (ticket === shotTicket)
      setShotStatus(
        e.message +
          " The screenshot will be uploaded again when you press Save.",
        "warn",
      );
  }
});

// ---------- Notifications (e.g. new payment data uploaded by On The Way Logistics) ----------
let notifications = [],
  notificationsLoaded = false;
async function loadNotifications({ announce = false } = {}) {
  if (!data) return;
  let out;
  try {
    out = await api("/api/portal/notifications?portal=" + PORTAL);
  } catch (e) {
    return;
  }
  if (!out.ok) return;
  const known = new Set(notifications.map((n) => n.id));
  const fresh = (out.items || []).filter((n) => !n.read && !known.has(n.id));
  notifications = out.items || [];
  if (announce && notificationsLoaded && fresh.length) {
    portalToast(
      "🔔 " +
        fresh[0].title +
        (fresh.length > 1 ? ` (+${fresh.length - 1} more)` : "") +
        " - see Notifications",
    );
    if (fresh.some((n) => n.kind === "payment")) refreshData({ quiet: true }); // new orders arrived: update Orders and Reports
  }
  notificationsLoaded = true;
  renderNotifications();
}
function renderNotifications() {
  const unread = notifications.filter((n) => !n.read).length,
    btn = document.querySelector('.nav[data-page="notifications"]');
  if (btn) {
    let b = btn.querySelector(".nav-count");
    if (unread) {
      if (!b) {
        b = document.createElement("b");
        b.className = "nav-count";
        btn.appendChild(b);
      }
      b.textContent = unread;
      b.title = unread + " unread";
    } else b?.remove();
  }
  const el = $("#notificationList");
  if (!el) return;
  el.innerHTML = notifications.length
    ? notifications
        .map(
          (n) =>
            `<div class="notice notification${n.read ? "" : " unread"}"><b>${n.read ? "" : '<i class="dot"></i>'}${esc(n.title)}</b><span>${esc(n.body)}</span><small>${esc(new Date(n.createdAt).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }))}</small></div>`,
        )
        .join("")
    : '<div class="notice"><b>No notifications yet</b><span>You will be notified here when On The Way Logistics uploads payment data for your riders.</span></div>';
}
async function markAllNotificationsRead() {
  if (!notifications.some((n) => !n.read)) return;
  try {
    const out = await api("/api/portal/notifications/read?portal=" + PORTAL, {
      method: "POST",
      body: {},
    });
    if (!out.ok) return;
  } catch (e) {
    return;
  }
  notifications.forEach((n) => (n.read = true));
  const btn = document.querySelector(
    '.nav[data-page="notifications"] .nav-count',
  );
  btn?.remove(); // keep the "new" highlight while the page is open
}
$("#markAllRead").addEventListener("click", () =>
  markAllNotificationsRead().then(renderNotifications),
);
// Opening Notifications marks them as read (after a moment, so the new ones are still highlighted).
document
  .querySelector('.nav[data-page="notifications"]')
  .addEventListener("click", () => {
    loadNotifications().then(() => setTimeout(markAllNotificationsRead, 1500));
  });
// Check for new notifications every 30 seconds and when coming back to the tab.
setInterval(() => {
  if (data && !document.hidden) loadNotifications({ announce: true });
}, 30000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && data) loadNotifications({ announce: true });
});

// ---------- Form checks for every portal form: names never contain numbers, contact numbers are exactly 10 digits ----------
const NAME_KINDS = {
  person: {
    re: /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u,
    chars: "letters, spaces and . ' -",
  },
  business: {
    re: /^[\p{L}\p{M}][\p{L}\p{M} .'&(),-]*$/u,
    chars: "letters, spaces and . ' - & ( ) ,",
  },
  place: {
    re: /^[\p{L}\p{M}][\p{L}\p{M} .'()-]*$/u,
    chars: "letters, spaces and . ' - ( )",
  },
};
const FIELD_RULES = {
  pName: "business",
  pContact: "person",
  pPhone: "phone",
  pEmail: "email",
  pState: "place",
  pDistrict: "place",
  pCity: "place",
  pPin: "pin",
  lName: "business",
  lCity: "place",
  lDistrict: "place",
  rName: "person",
  rPhone: "phone",
  rHubPin: "pin",
  supportName: "person",
  supportPhone: "phone",
  selfiePersonName: "person",
};
function fieldLabel(el) {
  const l = el.closest("label"),
    t = l
      ? [...l.childNodes]
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent)
          .join(" ")
      : "";
  return (
    t
      .replace(/\*|\(optional\)/gi, "")
      .replace(/\s+/g, " ")
      .trim() || "This field"
  );
}
// Returns what is wrong with a filled-in field ('' when it is fine; empty fields are checked by each form).
function fieldProblem(el) {
  const kind = FIELD_RULES[el.id],
    v = el.value.trim(),
    label = fieldLabel(el);
  if (!kind || !v) return "";
  if (kind === "phone") {
    if (!/^\d{10}$/.test(v)) return label + " must be exactly 10 digits.";
    return /^[6-9]/.test(v) ? "" : label + " must start with 6, 7, 8 or 9.";
  }
  if (kind === "pin")
    return /^[1-9]\d{5}$/.test(v) ? "" : label + " must be exactly 6 digits.";
  if (kind === "email")
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)
      ? ""
      : "Enter a valid email address.";
  if (/\d/.test(v)) return label + " cannot contain numbers.";
  if (!NAME_KINDS[kind].re.test(v))
    return label + " can only contain " + NAME_KINDS[kind].chars + ".";
  if ((v.match(/\p{L}/gu) || []).length < 2) return label + " is too short.";
  return "";
}
function showFieldError(el, msg) {
  let m = el.parentElement.querySelector(":scope > .field-msg");
  if (!m && msg) {
    m = document.createElement("small");
    m.className = "field-error field-msg";
    m.setAttribute("role", "alert");
    el.insertAdjacentElement("afterend", m);
  }
  if (m) m.textContent = msg || "";
  el.classList.toggle("invalid", !!msg);
  if (msg) el.setAttribute("aria-invalid", "true");
  else el.removeAttribute("aria-invalid");
}
function clearFieldErrors(root) {
  if (!root) return;
  root.querySelectorAll(".field-msg").forEach((m) => (m.textContent = ""));
  root.querySelectorAll(".invalid").forEach((el) => {
    el.classList.remove("invalid");
    el.removeAttribute("aria-invalid");
  });
}
// Checks the fields; ids in "required" must be filled in. Each problem is shown under its field and the first one gets the focus.
function validateFields(ids, required = []) {
  let first = null;
  for (const id of ids) {
    const el = $("#" + id);
    if (!el) continue;
    if (NAME_KINDS[FIELD_RULES[id]])
      el.value = el.value.replace(/\s+/g, " ").trim();
    const msg = !el.value.trim()
      ? required.includes(id)
        ? "Please enter " + fieldLabel(el) + "."
        : ""
      : fieldProblem(el);
    showFieldError(el, msg);
    if (msg && !first) first = el;
  }
  if (first) {
    first.focus();
    first.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  return !first;
}
// While typing: numbers are removed from names (with a message), contact numbers keep 10 digits ("+91 98765 43210" -> 9876543210), PIN codes 6 digits.
function cleanPhoneInput(v, prev) {
  let d = v.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length > 10) return /^\d{10}$/.test(prev || "") ? prev : d.slice(0, 10);
  return d;
}
for (const [id, kind] of Object.entries(FIELD_RULES)) {
  const el = $("#" + id);
  if (!el) continue;
  if (kind === "phone") {
    el.type = "tel";
    el.inputMode = "numeric";
    el.removeAttribute("maxlength");
    if (!el.placeholder)
      el.placeholder = "10-digit mobile number, e.g. 9876543210";
  }
  if (kind === "pin") {
    el.inputMode = "numeric";
    el.maxLength = 6;
    if (!el.placeholder) el.placeholder = "6-digit PIN code";
  }
  if (NAME_KINDS[kind] && el.maxLength < 0) el.maxLength = 100;
  el.addEventListener("focus", () => {
    el._prev = el.value;
  });
  el.addEventListener("input", () => {
    const v = el.value,
      pos = el.selectionStart ?? v.length;
    let clean = v,
      note = "",
      strip = null;
    if (kind === "phone") {
      clean = cleanPhoneInput(v, el._prev);
      if (clean === el._prev && clean !== v) {
        el.value = clean;
        const p = Math.max(0, pos - (v.length - clean.length));
        try {
          el.setSelectionRange(p, p);
        } catch {}
        return;
      }
    } else if (kind === "pin") {
      strip = /\D/g;
      clean = v.replace(strip, "").slice(0, 6);
    } else if (NAME_KINDS[kind] && /\d/.test(v)) {
      strip = /\d/g;
      clean = v.replace(strip, "");
      note = fieldLabel(el) + " cannot contain numbers.";
    }
    if (clean !== v) {
      el.value = clean;
      if (strip) {
        const p = Math.max(
          0,
          pos - (v.slice(0, pos).match(strip) || []).length,
        );
        try {
          el.setSelectionRange(p, p);
        } catch {}
      }
    }
    el._prev = el.value;
    // "cannot contain numbers" stays visible for a few seconds, even while the person keeps typing
    if (note) {
      showFieldError(el, note);
      clearTimeout(el._noteTimer);
      el._noteUntil = Date.now() + 3500;
      el._noteTimer = setTimeout(() => {
        el._noteUntil = 0;
        if (el.classList.contains("invalid"))
          showFieldError(el, fieldProblem(el));
      }, 3500);
    } else if (
      el.classList.contains("invalid") &&
      !(el._noteUntil > Date.now())
    )
      showFieldError(el, fieldProblem(el));
  });
  el.addEventListener("blur", () => {
    if (NAME_KINDS[kind]) el.value = el.value.replace(/\s+/g, " ").trim();
    if (el._noteUntil > Date.now()) return;
    if (el.value.trim()) showFieldError(el, fieldProblem(el));
  });
}

// ---------- Weekly Payments — Excel Automatic (Orders page) ----------
$("#weeklyPaymentsRefresh").onclick = () => loadVendorWeeklyPayments();
$("#weeklyPaymentCycle").onchange = () => {
  weeklyPaymentPage = 1;
  paintVendorWeeklyPayments();
};
$("#weeklyPaymentSearch").oninput = () => {
  weeklyPaymentPage = 1;
  paintVendorWeeklyPayments();
};
function cycleLabel(c) {
  return c === "weekly" ? "Weekly" : c === "15-day" ? "15-Day" : String(c);
}
function fillCycleOptions() {
  const sel = $("#weeklyPaymentCycle");
  if (!sel) return;
  const current = sel.value || "all";
  const cycles = [
    ...new Set(vendorWeeklyPayments.map((r) => r.cycle).filter(Boolean)),
  ].sort();
  sel.innerHTML =
    '<option value="all">All Cycles</option>' +
    cycles
      .map((c) => `<option value="${esc(c)}">${esc(cycleLabel(c))}</option>`)
      .join("");
  sel.value = cycles.includes(current) ? current : "all";
}
let weeklyRefreshBusy = false;
// Loads the weekly payment records from the server (never from the browser). Used by the Refresh button and by the
// automatic refresh. The timestamp moves only after a successful response; a failure keeps the rows already shown.
async function loadVendorWeeklyPayments(quiet = false) {
  if (weeklyRefreshBusy) {
    if (!quiet) portalToast("Already refreshing. Please wait.");
    return false;
  }
  weeklyRefreshBusy = true;
  const btn = $("#weeklyPaymentsRefresh"),
    label = btn ? btn.innerHTML : "";
  if (btn && !quiet) {
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.textContent = "Refreshing…";
  }
  try {
    const out = await api(
      "/api/portal/weekly-payments?portal=vendor" +
        (reportWeekKey ? "&week=" + encodeURIComponent(reportWeekKey) : ""),
    );
    if (!out.ok) {
      if (out.status === 401)
        throw new Error("Your session has ended. Please sign in again.");
      throw new Error(
        out.error || "Could not refresh the weekly payments. Please try again.",
      );
    }
    vendorWeeklyPayments = Array.isArray(out.records) ? out.records : [];
    portalReport = out.report || null;
    renderReports();
    const sync = $("#weeklyPaymentSync");
    if (sync)
      sync.textContent =
        "Updated " +
        new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
    paintVendorWeeklyPayments();
    if (!quiet) {
      const n = vendorWeeklyPayments.length;
      portalToast(
        n
          ? `Weekly payments refreshed: ${n} record${n === 1 ? "" : "s"}.`
          : "Weekly payments refreshed. No records yet.",
      );
    }
    return true;
  } catch (err) {
    const msg =
      err instanceof TypeError
        ? "Could not reach the server. Check your connection and try again."
        : err.message || "Could not refresh the weekly payments.";
    if (!quiet) portalToast(msg, true);
    const rows = $("#vendorWeeklyPaymentRows");
    if (rows && !vendorWeeklyPayments.length)
      rows.innerHTML =
        '<tr><td colspan="15">Could not load weekly payments. Press Refresh to try again.</td></tr>';
    return false;
  } finally {
    weeklyRefreshBusy = false;
    if (btn && !quiet) {
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
      btn.innerHTML = label;
    }
  }
}
function paintVendorWeeklyPayments() {
  const body = $("#vendorWeeklyPaymentRows");
  if (!body) return;
  fillCycleOptions();
  const q = ($("#weeklyPaymentSearch")?.value || "").trim().toLowerCase(),
    cycle = $("#weeklyPaymentCycle")?.value || "all";
  const rows = vendorWeeklyPayments.filter(
    (r) =>
      (cycle === "all" || r.cycle === cycle) &&
      [r.riderId, r.riderName, r.week, cycleLabel(r.cycle)]
        .join(" ")
        .toLowerCase()
        .includes(q),
  );
  const pageSize = 25,
    pages = Math.max(1, Math.ceil(rows.length / pageSize));
  weeklyPaymentPage = Math.min(Math.max(1, weeklyPaymentPage), pages);
  const pageRows = rows.slice(
    (weeklyPaymentPage - 1) * pageSize,
    weeklyPaymentPage * pageSize,
  );
  const num = (v) => Number(v) || 0,
    cell = (v) => (v === null || v === undefined || v === "" ? "—" : num(v));
  body.innerHTML =
    pageRows
      .map(
        (r, i) =>
          `<tr><td>${(weeklyPaymentPage - 1) * pageSize + i + 1}</td><td><b>${esc(r.riderId)}</b></td><td>${esc(r.riderName)}</td><td>${esc(r.week)}</td><td>${cell(r.days)}</td><td>${cell(r.totalOrders)}</td><td>${cell(r.lm)}</td><td>${cell(r.primaryOrders)}</td><td>${cell(r.club)}</td><td>${cell(r.sdd)}</td><td>${r.lmAmount == null ? "—" : "₹" + num(r.lmAmount).toFixed(2)}</td><td>${r.primeAmount == null ? "—" : "₹" + num(r.primeAmount).toFixed(2)}</td><td>${r.clubAmount == null ? "—" : "₹" + num(r.clubAmount).toFixed(2)}</td><td>${r.sddAmount == null ? "—" : "₹" + num(r.sddAmount).toFixed(2)}</td><td>₹${num(r.amount).toFixed(2)}</td></tr>`,
      )
      .join("") ||
    (vendorWeeklyPayments.length
      ? '<tr><td colspan="15">No records match your search or cycle filter.</td></tr>'
      : '<tr><td colspan="15">No weekly payment records are available yet. They appear here after Admin imports the Excel sheet.</td></tr>');
  const totals = $("#vendorWeeklyPaymentTotal");
  if (totals) {
    const sum = (k) => rows.reduce((a, r) => a + num(r[k]), 0);
    totals.innerHTML = rows.length
      ? `<tr><th colspan="5">Total</th><th>${sum("totalOrders")}</th><th>${sum("lm")}</th><th>${sum("primaryOrders")}</th><th>${sum("club")}</th><th>${sum("sdd")}</th><th>₹${sum("lmAmount").toFixed(2)}</th><th>₹${sum("primeAmount").toFixed(2)}</th><th>₹${sum("clubAmount").toFixed(2)}</th><th>₹${sum("sddAmount").toFixed(2)}</th><th>₹${sum("amount").toFixed(2)}</th></tr>`
      : "";
  }
  const pager = $("#vendorWeeklyPagination");
  if (pager) {
    const start = rows.length ? (weeklyPaymentPage - 1) * pageSize + 1 : 0,
      end = Math.min(weeklyPaymentPage * pageSize, rows.length);
    pager.innerHTML = `<span>Showing ${start}–${end} of ${rows.length} records</span><div><button type="button" class="btn-sm weekly-page-btn" id="vendorWeeklyBack" ${weeklyPaymentPage <= 1 ? "disabled" : ""}>Back</button><span> Page ${weeklyPaymentPage} of ${pages} </span><button type="button" class="btn-sm primary weekly-page-btn" id="vendorWeeklyNext" ${weeklyPaymentPage >= pages ? "disabled" : ""}>Next</button></div>`;
    $("#vendorWeeklyBack")?.addEventListener("click", () => {
      if (weeklyPaymentPage > 1) {
        weeklyPaymentPage--;
        paintVendorWeeklyPayments();
      }
    });
    $("#vendorWeeklyNext")?.addEventListener("click", () => {
      if (weeklyPaymentPage < pages) {
        weeklyPaymentPage++;
        paintVendorWeeklyPayments();
      }
    });
  }
}
