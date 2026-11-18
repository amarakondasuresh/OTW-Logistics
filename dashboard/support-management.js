// Admin Portal > Support: every support request, its conversation, and the status of its emails.
// Ticket status (New, Pending, In Progress, Resolved, Rejected, Closed) and email status (Pending, Sending,
// Sent, Retrying, Failed) are separate columns and are changed separately.
// Data comes from backend/support-routes.js. Uses globals from app.js: $, esc, layout, stat, toast, openModal,
// fmtDate, currentPage, PARTNER_API_BASE, sessionEnded.

const supStore = { tickets: [], summary: null, error: "", status: "", portal: "", q: "", open: null, inbound: null, photoUrl: "" };
const SUP_TICKET_STATUSES = ["New", "Pending", "In Progress", "Resolved", "Rejected", "Closed"];

async function supRequest(path, { method = "GET", body } = {}) {
  let r;
  try {
    r = await fetch(PARTNER_API_BASE + "/api/admin/support" + path, {
      method,
      credentials: "include",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error("The server is not reachable. Check that it is running and try again.");
  }
  const out = await r.json().catch(() => ({}));
  if (r.status === 401) {
    sessionEnded();
    throw new Error("Your session has ended. Please sign in again.");
  }
  if (!r.ok) {
    const err = new Error(out.error || "Request failed (" + r.status + ")");
    err.field = out.field || "";
    throw err;
  }
  return out;
}

const badgeFor = (s) => {
  const cls =
    s === "Resolved" || s === "Closed" || s === "Sent" ? "success"
    : s === "Rejected" || s === "Failed" ? "danger"
    : s === "New" || s === "Pending" || s === "Retrying" || s === "Sending" ? "warning"
    : "";
  return `<span class="badge ${cls}">${esc(s)}</span>`;
};
const shortText = (v, n = 90) => {
  const t = String(v || "");
  return t.length > n ? esc(t.slice(0, n)) + "…" : esc(t) || "—";
};

function supportManagement() {
  return (
    layout(
      "Support",
      "Every Helpline / Support request, the customer's email conversation, and the status of each email.",
      '<button class="secondary" id="supRefresh">Refresh</button>',
    ) +
    `<div class="cards">${stat("Total Support Requests", "—", "supTotal")}${stat("New Requests", "—", "supNew")}${stat("Pending Requests", "—", "supPending")}${stat("In Progress", "—", "supProgress")}${stat("Resolved Requests", "—", "supResolved")}${stat("Failed Email Notifications", "—", "supFailed")}</div>
    <div class="card" id="supInboundCard"></div>
    <div class="card">
      <div class="hub-list-toolbar">
        <div><h3>Support requests</h3><span class="muted" id="supCount"></span></div>
        <div class="actions">
          <input class="search hub-search" id="supSearch" placeholder="Search ticket, name, email, phone or account..." autocomplete="off" value="${esc(supStore.q)}">
          <select id="supStatusFilter"><option value="">All ticket statuses</option>${SUP_TICKET_STATUSES.map((s) => `<option ${supStore.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
          <select id="supPortalFilter"><option value="">All portals</option>${["Franchise", "Vendor", "Email"].map((p) => `<option ${supStore.portal === p ? "selected" : ""}>${p}</option>`).join("")}</select>
        </div>
      </div>
      <div id="supAlert"></div>
      <div class="table-wrap"><table class="table"><thead><tr>
        <th>Ticket ID</th><th>Portal Type</th><th>Customer Name</th><th>Email Address</th><th>Contact Number</th>
        <th>Problem Description</th><th>Photo</th><th>Submitted Date</th><th>Ticket Status</th><th>Email Status</th><th>Admin Response</th><th>Action</th>
      </tr></thead><tbody id="supRows"><tr><td colspan="12" class="empty">Loading support requests…</td></tr></tbody></table></div>
    </div>`
  );
}

function bindSupport() {
  $("#supRefresh").onclick = () => supLoad();
  $("#supSearch").oninput = (e) => {
    supStore.q = e.target.value;
    clearTimeout(bindSupport._t);
    bindSupport._t = setTimeout(() => supLoad(), 250);
  };
  $("#supStatusFilter").onchange = (e) => {
    supStore.status = e.target.value;
    supLoad();
  };
  $("#supPortalFilter").onchange = (e) => {
    supStore.portal = e.target.value;
    supLoad();
  };
  $("#supRows").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-sup-open]");
    if (btn) supOpen(btn.dataset.supOpen, btn.dataset.focus === "reply");
  });
  supPaint();
  supLoad();
  supLoadInbound();
}

async function supLoad() {
  try {
    const qs = new URLSearchParams();
    if (supStore.status) qs.set("status", supStore.status);
    if (supStore.portal) qs.set("portal", supStore.portal);
    if (supStore.q.trim()) qs.set("q", supStore.q.trim());
    const out = await supRequest("/tickets?" + qs.toString());
    supStore.tickets = out.tickets || [];
    supStore.summary = out.summary || null;
    supStore.error = "";
  } catch (e) {
    supStore.error = e.message;
  }
  supPaint();
}

async function supLoadInbound() {
  try {
    supStore.inbound = await supRequest("/inbound");
  } catch (e) {
    supStore.inbound = { enabled: false, setupNote: e.message };
  }
  supPaintInbound();
}

function supPaintInbound() {
  const box = $("#supInboundCard");
  if (!box || currentPage !== "support") return;
  const i = supStore.inbound || {};
  const state = i.enabled
    ? `<span class="badge success">Connected</span> Reading incoming mail for <b>${esc(i.mailbox || "")}</b>.${i.lastPollAt ? ` Last checked ${esc(fmtDate(i.lastPollAt))}.` : ""}`
    : `<span class="badge warning">Not connected</span> ${esc(i.setupNote || "")}`;
  const err = i.lastError ? `<p class="support-status error">Last inbox check failed: ${esc(i.lastError)}</p>` : "";
  box.innerHTML = `<div class="hub-list-toolbar"><div><h3>Incoming customer email</h3><p>${state}</p></div>
    <div class="actions"><button class="secondary" id="supCheckInbox" ${i.enabled ? "" : "disabled"}>Check inbox now</button></div></div>${err}`;
  const btn = $("#supCheckInbox");
  if (btn)
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const out = await supRequest("/inbound/check", { method: "POST" });
        toast(`Inbox checked: ${out.handled} new message(s)`);
        supStore.inbound = out;
        supLoad();
      } catch (e) {
        toast(e.message);
      }
      supPaintInbound();
    };
}

function supPaint() {
  if (currentPage !== "support" || !$("#supRows")) return;
  const s = supStore.summary || {};
  const set = (id, v) => {
    const el = $("#" + id);
    if (el) el.textContent = supStore.summary ? v : "—";
  };
  set("supTotal", s.total);
  set("supNew", s.new);
  set("supPending", s.pending);
  set("supProgress", s.inProgress);
  set("supResolved", s.resolved);
  set("supFailed", s.failedEmails);
  if (supStore.error) {
    $("#supRows").innerHTML = `<tr><td colspan="12" class="empty error">${esc(supStore.error)}</td></tr>`;
    return;
  }
  $("#supAlert").innerHTML = s.failedEmails
    ? `<p class="support-status error">${s.failedEmails} email(s) failed to send. Open the ticket to see the reason and retry.</p>`
    : "";
  $("#supCount").textContent = `${supStore.tickets.length} shown`;
  $("#supRows").innerHTML = supStore.tickets.length
    ? supStore.tickets
        .map((t) => {
          const e = t.newTicketEmail;
          const emailCell = e
            ? `${badgeFor(e.status)}${e.lastError ? `<br><small class="muted" title="${esc(e.lastError)}">${esc(e.lastError.slice(0, 60))}</small>` : ""}`
            : `<span class="muted">Not queued</span>`;
          return `<tr>
            <td><b>${esc(t.ticketId)}</b></td>
            <td>${esc(t.portalType)}${t.signedIn ? `<br><small class="muted">${esc(t.accountLogin)}</small>` : ""}</td>
            <td>${esc(t.customerName)}</td>
            <td>${esc(t.email)}</td>
            <td>${esc(t.phone) || "—"}</td>
            <td style="max-width:260px">${shortText(t.description)}</td>
            <td>${t.photo ? `<button class="link-btn" data-sup-open="${esc(t.id)}">View photo</button>` : '<span class="muted">None</span>'}</td>
            <td>${esc(fmtDate(t.submittedAt))}</td>
            <td>${badgeFor(t.status)}${t.awaitingReply ? `<br><span class="badge warning" title="${esc(fmtDate(t.lastCustomerMessageAt))}">New customer email</span>` : ""}</td>
            <td>${emailCell}</td>
            <td style="max-width:220px">${shortText(t.adminResponse, 70)}</td>
            <td><button class="secondary" data-sup-open="${esc(t.id)}">View</button> <button class="secondary" data-sup-open="${esc(t.id)}" data-focus="reply">Reply</button></td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="12" class="empty">No support requests match these filters.</td></tr>`;
}

async function supOpen(id, focusReply = false) {
  try {
    supStore.open = await supRequest("/tickets/" + encodeURIComponent(id));
    supRenderModal(focusReply);
  } catch (e) {
    toast(e.message);
  }
}

function supRenderModal(focusReply) {
  const { ticket: t, events, emailJobs = [] } = supStore.open;
  const who = (ev) => (ev.authorRole === "admin" ? "Admin" : ev.authorRole === "customer" ? "Customer" : ev.author);
  const label = (ev) =>
    ev.kind === "submitted" ? "Submitted"
    : ev.kind === "reply" ? "Admin reply"
    : ev.kind === "customer_email" ? "Customer email"
    : ev.kind === "followup" ? "Partner follow-up"
    : "Status changed to " + ev.status;
  const history = events.length
    ? events
        .map((ev) => `<div class="sup-event" style="margin:8px 0;padding:10px;border-radius:10px;background:rgba(0,0,0,.04)">
            <div><b>${esc(label(ev))}</b> · ${esc(who(ev))} · <span class="muted">${esc(fmtDate(ev.createdAt))}</span></div>
            ${ev.body ? `<p style="margin:6px 0 0;white-space:pre-wrap">${esc(ev.body)}</p>` : ""}</div>`)
        .join("")
    : `<p class="muted">No history yet.</p>`;
  const jobs = emailJobs.length
    ? `<table class="table"><thead><tr><th>Email</th><th>To</th><th>Email status</th><th>Attempts</th><th>Error</th><th></th></tr></thead><tbody>${emailJobs
        .map(
          (j) => `<tr>
            <td>${esc(j.subject)}<br><small class="muted">${esc(fmtDate(j.createdAt))}</small></td>
            <td>${esc(j.to)}${j.cc ? `<br><small class="muted">cc ${esc(j.cc)}</small>` : ""}</td>
            <td>${badgeFor(j.status)}${j.sentAt ? `<br><small class="muted">${esc(fmtDate(j.sentAt))}</small>` : ""}${j.nextAttemptAt ? `<br><small class="muted">Next try ${esc(fmtDate(j.nextAttemptAt))}</small>` : ""}</td>
            <td>${j.attempts}</td>
            <td style="max-width:260px">${j.lastError ? `<details><summary>View error</summary><code style="white-space:pre-wrap">${esc(j.lastError)}</code></details>` : '<span class="muted">—</span>'}${(j.attemptLog || []).length ? `<details><summary>Attempt log (${j.attemptLog.length})</summary>${j.attemptLog.map((a) => `<div><small>${esc(fmtDate(a.at))} · attempt ${a.attemptNo} · <b>${esc(a.outcome)}</b>${a.detail ? ` · ${esc(a.detail)}` : ""}</small></div>`).join("")}</details>` : ""}</td>
            <td>${j.canRetry ? `<button class="primary" data-sup-action="retry" data-job="${esc(j.id)}">Retry Email</button>` : ""}</td>
          </tr>`,
        )
        .join("")}</tbody></table>`
    : `<p class="muted">No emails for this ticket.</p>`;
  openModal(`
    <div class="sup-detail">
      <h3>Ticket ${esc(t.ticketId)} <span class="muted">· ${esc(t.portalType)}</span></h3>
      <div class="sup-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
        <div><span class="muted">Customer</span><br><b>${esc(t.customerName)}</b></div>
        <div><span class="muted">Email</span><br>${esc(t.email)}</div>
        <div><span class="muted">Contact</span><br>${esc(t.phone) || "Not provided"}</div>
        <div><span class="muted">Submitted</span><br>${esc(fmtDate(t.submittedAt))}</div>
        <div><span class="muted">Ticket status</span><br>${badgeFor(t.status)}</div>
        <div><span class="muted">Account</span><br>${esc(t.accountLogin) || "Not signed in"}</div>
      </div>
      <h4>Problem description</h4>
      <p class="sup-desc" style="white-space:pre-wrap">${esc(t.description)}</p>
      <h4>Photo</h4>
      <div id="supPhoto">${t.photo ? '<span class="muted">Loading photo…</span>' : '<span class="muted">No photo was attached.</span>'}</div>
      <h4>Communication history</h4>
      <div class="sup-history">${history}</div>
      <h4>Emails for this ticket</h4>
      <p class="muted" style="margin-top:0">Email status is separate from the ticket status above. "Sent" means the mail server accepted the message.</p>
      ${jobs}
      <h4>Reply to customer</h4>
      <textarea id="supReplyText" rows="3" maxlength="3000" placeholder="Write your reply. It is emailed to ${esc(t.email)} and saved to ${esc(t.ticketId)}."></textarea>
      <div class="actions"><button class="primary" data-sup-action="reply">Send reply</button></div>
      <h4>Update ticket status</h4>
      <div class="actions">
        <select id="supStatusSelect">${SUP_TICKET_STATUSES.map((s) => `<option ${s === t.status ? "selected" : ""}>${s}</option>`).join("")}</select>
        <input id="supStatusNote" maxlength="3000" placeholder="Optional note for the record">
        <button class="secondary" data-sup-action="status">Save status</button>
      </div>
      <p class="support-status" id="supModalStatus"></p>
    </div>`);
  if (t.photo) supLoadPhoto(t.id);
  if (focusReply) setTimeout(() => $("#supReplyText")?.focus(), 0);
  bindSupportModal();
}

function bindSupportModal() {
  const body = $("#modalBody");
  if (!body || body.dataset.supBound === "1") return;
  body.dataset.supBound = "1";
  body.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-sup-action]");
    if (!btn || !supStore.open) return;
    const id = supStore.open.ticket.id;
    const msg = $("#supModalStatus");
    const action = btn.dataset.supAction;
    try {
      btn.disabled = true;
      if (action === "reply") {
        const text = $("#supReplyText").value.trim();
        if (!text) throw new Error("Please type your reply before sending.");
        const out = await supRequest(`/tickets/${encodeURIComponent(id)}/reply`, { method: "POST", body: { message: text } });
        supStore.open = out;
        toast(out.replyEmail?.status === "Sent" ? "Reply emailed to the customer" : "Reply saved. The email is queued or failed; see Emails for this ticket.");
      } else if (action === "status") {
        supStore.open = await supRequest(`/tickets/${encodeURIComponent(id)}/status`, {
          method: "POST",
          body: { status: $("#supStatusSelect").value, note: $("#supStatusNote").value.trim() },
        });
        toast("Ticket status saved");
      } else if (action === "retry") {
        const out = await supRequest(`/emails/${encodeURIComponent(btn.dataset.job)}/retry`, { method: "POST" });
        toast(out.job.status === "Sent" ? "Email sent: the server accepted it" : "Retry did not succeed: " + (out.job.lastError || out.job.status));
        supStore.open = await supRequest("/tickets/" + encodeURIComponent(id));
      }
      supRenderModal(false);
      supLoad();
    } catch (err) {
      btn.disabled = false;
      if (msg) {
        msg.className = "support-status error";
        msg.textContent = err.message;
      }
    }
  });
}

async function supLoadPhoto(id) {
  const box = $("#supPhoto");
  if (!box) return;
  try {
    const r = await fetch(`${PARTNER_API_BASE}/api/admin/support/tickets/${encodeURIComponent(id)}/photo`, { credentials: "include" });
    if (!r.ok) throw new Error("The photo could not be loaded.");
    if (supStore.photoUrl) URL.revokeObjectURL(supStore.photoUrl);
    supStore.photoUrl = URL.createObjectURL(await r.blob());
    if ($("#supPhoto"))
      $("#supPhoto").innerHTML = `<a href="${supStore.photoUrl}" target="_blank" rel="noopener"><img src="${supStore.photoUrl}" alt="Photo attached to the support request" style="max-width:100%;border-radius:10px"></a>`;
  } catch (e) {
    if ($("#supPhoto")) $("#supPhoto").innerHTML = `<span class="error">${esc(e.message)}</span>`;
  }
}

// Refresh every minute while this page is open.
setInterval(() => {
  if (currentPage === "support") {
    supLoad();
    supLoadInbound();
  }
}, 60_000);
