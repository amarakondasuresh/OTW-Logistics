// Admin notifications for Franchise / Vendor applications submitted on the website.
// Loaded before app.js. It uses helpers defined there ($, esc, toast, render, currentPage, viewPartner,
// syncPartnerApplications, sessionEnded, PARTNER_API_BASE), so every name here starts with "notif".
//
// Real-time: the page keeps one EventSource open to /api/admin/notifications/stream (signed-in admins only).
// A new application shows a popup, plays the sound (if on) and updates the badges without a page refresh.
// The list is also reloaded every 30 seconds, so a dropped connection never leaves the badge stale.
// Notifications waiting while the admin was offline are in the database and load at sign-in.

let notifState = { items: [], unreadCount: 0, type: "", status: "" };
let notifStream = null;
let notifReconnectTimer = null;
let notifPopupTimer = null;
let notifAudio = null;
const NOTIF_SOUND_KEY = "otw_notification_sound";

const notifApi = (path = "", options = {}) =>
  fetch(PARTNER_API_BASE + "/api/admin/notifications" + path, {
    ...options,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  }).then((r) => {
    if (r.status === 401) sessionEnded();
    return r;
  });

function notifSoundOn() {
  return localStorage.getItem(NOTIF_SOUND_KEY) !== "off";
}

// Browsers only allow sound after the user has clicked something on the page, so the audio context is
// unlocked on the first click. Until then the popup still appears; only the sound is skipped.
function notifUnlockAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    notifAudio = notifAudio || new Ctx();
    if (notifAudio.state === "suspended") notifAudio.resume();
  } catch (_) {}
}
document.addEventListener("click", notifUnlockAudio, { once: true });

function notifPlaySound() {
  if (!notifSoundOn()) return;
  try {
    notifUnlockAudio();
    if (!notifAudio || notifAudio.state !== "running") return;
    const t = notifAudio.currentTime;
    [
      [880, 0],
      [1175, 0.22],
    ].forEach(([freq, offset]) => {
      const osc = notifAudio.createOscillator();
      const gain = notifAudio.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + offset);
      gain.gain.exponentialRampToValueAtTime(0.25, t + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + offset + 0.4);
      osc.connect(gain).connect(notifAudio.destination);
      osc.start(t + offset);
      osc.stop(t + offset + 0.45);
    });
  } catch (_) {}
}

function notifToggleSound() {
  localStorage.setItem(NOTIF_SOUND_KEY, notifSoundOn() ? "off" : "on");
  if (notifSoundOn()) notifPlaySound();
  if (currentPage === "notifications") paintNotifications();
}

// Nav badge and bell badge. Hidden when nothing is unread.
function notifUpdateBadges() {
  const n = notifState.unreadCount;
  const label = n > 99 ? "99+" : String(n);
  ["notifNavCount", "notifBellCount"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = label;
    el.hidden = n === 0;
  });
  const bell = document.getElementById("notifBell");
  if (bell)
    bell.setAttribute(
      "aria-label",
      n ? `Notifications, ${n} unread` : "Notifications",
    );
}

async function notifLoad({ quiet = false } = {}) {
  if (!currentUser) return;
  const params = new URLSearchParams();
  if (notifState.type) params.set("type", notifState.type);
  if (notifState.status) params.set("status", notifState.status);
  try {
    const r = await notifApi("?" + params.toString());
    if (!r.ok) throw new Error("Server responded " + r.status);
    const data = await r.json();
    notifState.items = data.items || [];
    notifState.unreadCount = Number(data.unreadCount || 0);
    notifUpdateBadges();
    if (currentPage === "notifications") paintNotifications();
  } catch (err) {
    if (!quiet) toast("Could not load notifications. Check the server connection.");
    console.warn("Notifications load failed:", err);
  }
}

// ---------- Page ----------
function notificationsPage() {
  const opts = (list, value) =>
    list.map(([v, label]) => `<option value="${v}"${value === v ? " selected" : ""}>${label}</option>`).join("");
  const soundLabel = notifSoundOn() ? "🔔 Sound on" : "🔕 Sound off";
  return (
    layout(
      "Notifications",
      "Every Franchise and Vendor application sent in from the website. Open an application to see its complete details.",
      `<button class="ghost" id="notifSoundToggle" type="button">${soundLabel}</button>`,
    ) +
    `<div class="card"><div class="hub-list-toolbar"><div><h3>New applications</h3><span class="muted">Unread: <b id="notifUnreadText">${notifState.unreadCount}</b></span></div><div class="partner-filters"><select id="notifType" class="status-filter" aria-label="Filter by application type"><option value="">All types</option>${opts([["Vendor", "Vendor"], ["Franchise", "Franchise"]], notifState.type)}</select><select id="notifStatus" class="status-filter" aria-label="Filter by status"><option value="">All statuses</option>${opts([["New", "New (unread)"], ["Pending", "Pending"], ["Approved", "Approved"], ["Rejected", "Rejected"]], notifState.status)}</select></div></div><div class="table-wrap"><table class="table"><thead><tr><th>Application ID</th><th>Applicant Name</th><th>Type</th><th>Mobile</th><th>Email</th><th>Date</th><th>Time</th><th>Status</th><th>Admin email</th><th>Actions</th></tr></thead><tbody id="notifRows"><tr><td colspan="10" class="empty">Loading…</td></tr></tbody></table></div></div>`
  );
}

function notifStatusCell(n) {
  const cls = n.status === "Approved" ? "success" : n.status === "Rejected" ? "danger" : "warning";
  return `<span class="badge ${cls}">${esc(n.status)}</span>${n.unread ? ' <span class="badge info notif-new-tag">New</span>' : ""}`;
}

function notifEmailCell(n) {
  if (n.emailStatus === "sent")
    return `<span class="badge success" title="${esc(n.emailSentAt ? new Date(n.emailSentAt).toLocaleString() : "")}">Sent</span>`;
  if (n.emailStatus === "failed")
    return `<span class="badge danger" title="${esc(n.emailError)}">Failed</span> <button class="btn-sm" type="button" onclick="notifResend('${esc(n.id)}')">Resend</button>`;
  return `<span class="badge warning">Queued</span>`;
}

function paintNotifications() {
  const body = document.getElementById("notifRows");
  if (!body) return;
  const unread = document.getElementById("notifUnreadText");
  if (unread) unread.textContent = String(notifState.unreadCount);
  const toggle = document.getElementById("notifSoundToggle");
  if (toggle) toggle.textContent = notifSoundOn() ? "🔔 Sound on" : "🔕 Sound off";
  body.innerHTML =
    notifState.items
      .map((n) => {
        const id = esc(n.id);
        return `<tr class="${n.unread ? "notif-unread" : ""}"><td><b>${esc(n.appId)}</b></td><td>${esc(n.name)}</td><td>${esc(n.type)}</td><td>${esc(n.mobile)}</td><td>${esc(n.email)}</td><td>${esc(n.submissionDate)}</td><td>${esc(n.submissionTime)}</td><td>${notifStatusCell(n)}</td><td>${notifEmailCell(n)}</td><td><div class="row-actions"><button class="btn-sm primary" type="button" onclick="notifView('${id}','${esc(n.applicationId)}')">View Application</button><button class="btn-sm" type="button" onclick="notifToggleRead('${id}',${n.unread ? "true" : "false"})">${n.unread ? "Mark as Read" : "Mark as Unread"}</button><button class="btn-sm danger" type="button" onclick="notifDelete('${id}')">Delete</button></div></td></tr>`;
      })
      .join("") ||
    '<tr><td colspan="10" class="empty">No notifications match these filters.</td></tr>';
}

function bindNotifications() {
  document.getElementById("notifType")?.addEventListener("change", (e) => {
    notifState.type = e.target.value;
    notifLoad();
  });
  document.getElementById("notifStatus")?.addEventListener("change", (e) => {
    notifState.status = e.target.value;
    notifLoad();
  });
  document.getElementById("notifSoundToggle")?.addEventListener("click", notifToggleSound);
  notifLoad();
}

// ---------- Actions ----------
async function notifSetRead(id, read) {
  const r = await notifApi(`/${encodeURIComponent(id)}/${read ? "read" : "unread"}`, { method: "POST" });
  if (!r.ok) return toast("Could not update that notification.");
  const data = await r.json();
  notifState.unreadCount = Number(data.unreadCount || 0);
  notifUpdateBadges();
  await notifLoad({ quiet: true });
}

// currentlyUnread comes from the row: unread -> mark as read, read -> mark as unread.
window.notifToggleRead = (id, currentlyUnread) => notifSetRead(id, currentlyUnread === true);

window.notifDelete = async (id) => {
  if (!confirm("Delete this notification? The application itself is kept and stays in Partner Applications.")) return;
  const r = await notifApi(`/${encodeURIComponent(id)}/delete`, { method: "POST" });
  if (!r.ok) return toast("Could not delete that notification.");
  const data = await r.json();
  notifState.unreadCount = Number(data.unreadCount || 0);
  notifState.items = notifState.items.filter((n) => n.id !== id);
  notifUpdateBadges();
  paintNotifications();
  toast("Notification deleted");
};

window.notifResend = async (id) => {
  const r = await notifApi(`/${encodeURIComponent(id)}/resend-email`, { method: "POST" });
  const data = await r.json().catch(() => ({}));
  if (data.ok) toast("Admin email sent");
  else toast("Email could not be sent: " + ((data.emailStatus && data.emailStatus.error) || "check the server window"));
  notifLoad({ quiet: true });
};

// Opens the complete application (the same View form as Partner Applications) and marks it read.
window.notifView = async (id, applicationId) => {
  await syncPartnerApplications();
  if (!((db.partners || []).some((p) => p.id === applicationId))) {
    toast("That application is no longer available.");
    return;
  }
  const item = notifState.items.find((n) => n.id === id);
  if (item && item.unread) await notifSetRead(id, true);
  window.viewPartner(applicationId);
};

// ---------- Popup ----------
function notifShowPopup(data) {
  const type = data.type === "Vendor" ? "Vendor" : "Franchise";
  document.getElementById("notifPopup")?.remove();
  const popup = document.createElement("div");
  popup.id = "notifPopup";
  popup.className = "notif-popup";
  popup.setAttribute("role", "alert");
  popup.innerHTML = `<div class="notif-popup-title">New ${esc(type)} Application Received!</div><div class="notif-popup-body">A new ${esc(type)} Application has been submitted successfully. Please check the application details.</div><div class="notif-popup-actions"><button type="button" class="btn-sm primary" id="notifPopupView">View Application</button><button type="button" class="btn-sm" id="notifPopupClose">Dismiss</button></div>`;
  document.body.appendChild(popup);
  popup.querySelector("#notifPopupClose").onclick = () => popup.remove();
  popup.querySelector("#notifPopupView").onclick = () => {
    popup.remove();
    render("notifications");
    window.notifView(data.id, data.applicationId);
  };
  clearTimeout(notifPopupTimer);
  notifPopupTimer = setTimeout(() => popup.remove(), 60_000);
}

// ---------- Real-time stream ----------
function notifConnect() {
  if (notifStream || !window.EventSource) return;
  const es = new EventSource(PARTNER_API_BASE + "/api/admin/notifications/stream", { withCredentials: true });
  notifStream = es;
  es.addEventListener("ready", (e) => {
    try {
      notifState.unreadCount = Number(JSON.parse(e.data).unreadCount || 0);
      notifUpdateBadges();
    } catch (_) {}
  });
  es.addEventListener("notification", (e) => {
    let data = {};
    try {
      data = JSON.parse(e.data);
    } catch (_) {}
    notifOnArrival(data);
  });
  es.onerror = () => {
    // The browser retries by itself while the connection is open. If the server closed it (for example the
    // session ended), try again later; the 30-second reload keeps the badge correct meanwhile.
    if (es.readyState === EventSource.CLOSED) {
      notifStream = null;
      clearTimeout(notifReconnectTimer);
      notifReconnectTimer = setTimeout(() => currentUser && notifConnect(), 30_000);
    }
  };
}

function notifDisconnect() {
  if (notifStream) notifStream.close();
  notifStream = null;
  clearTimeout(notifReconnectTimer);
  clearTimeout(notifPopupTimer);
  document.getElementById("notifPopup")?.remove();
}

function notifOnArrival(data) {
  notifPlaySound();
  notifShowPopup(data);
  notifLoad({ quiet: true });
  // Keep the Partner Applications list in step without a page refresh.
  syncPartnerApplications();
}

// ---------- Start / stop (called from app.js at sign-in and sign-out) ----------
function notifStart() {
  notifConnect();
  const bell = document.getElementById("notifBell");
  if (bell) bell.onclick = () => render("notifications");
  notifLoad({ quiet: true }).then(notifOpenFromEmailLink);
}

function notifStop() {
  notifDisconnect();
  notifState = { items: [], unreadCount: 0, type: "", status: "" };
  notifUpdateBadges();
}

// Admin emails link to /dashboard/?notification=<id>. After sign-in, open that application.
function notifOpenFromEmailLink() {
  const params = new URLSearchParams(location.search);
  const id = params.get("notification");
  if (!id) return;
  history.replaceState(null, "", location.pathname);
  render("notifications");
  const item = notifState.items.find((n) => n.id === id);
  if (item) window.notifView(item.id, item.applicationId);
  else toast("That notification is no longer in your list.");
}
