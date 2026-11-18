// Subjects and bodies of the support emails. Kept together so every email uses the same wording.

export const NEW_TICKET_SUBJECT = (ticketNo) => `New Support Ticket – ON THE WAY LOGISTICS – ${ticketNo}`;
export const REPLY_SUBJECT = (ticketNo) => `Re: Your support request – ON THE WAY LOGISTICS – ${ticketNo}`;
export const NOTICE_SUBJECT = (ticketNo) => `Customer email received – ON THE WAY LOGISTICS – ${ticketNo}`;
export const FOLLOWUP_SUBJECT = (ticketNo) => `Follow-up on support ticket – ON THE WAY LOGISTICS – ${ticketNo}`;

// Where the ticket can be found in the Admin Portal. PUBLIC_URL is used when it is set.
function adminLink(ticketNo, baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return base ? `${base}/dashboard/#support (ticket ${ticketNo})` : `Admin Portal > Support (ticket ${ticketNo})`;
}

export function newTicketBody(t, { baseUrl = "" } = {}) {
  return [
    "New Helpline / Support request",
    "",
    `Support Ticket ID: ${t.ticket_no}`,
    `Portal Type: ${t.portal_type}${t.account_login ? ` (account ${t.account_login})` : ""}`,
    `Customer Name: ${t.customer_name}`,
    `Customer Email: ${t.email}`,
    `Contact Number: ${t.phone || "Not provided"}`,
    `Submitted: ${t.submitted_at}`,
    t.photo_path ? "Uploaded photo: attached to this email" : "Uploaded photo: none",
    "",
    "Problem Description:",
    t.description,
    "",
    `Admin Portal ticket details: ${adminLink(t.ticket_no, baseUrl)}`,
    "Reply to the customer from the Admin Portal, not by replying to this email, so the reply is logged against the ticket.",
  ].join("\n");
}

export function replyBody(ticketNo, text) {
  return [
    `Hello,`,
    "",
    text,
    "",
    `Your Ticket ID is ${ticketNo}. Please keep this number in your reply.`,
    "",
    "ON THE WAY LOGISTICS Support",
  ].join("\n");
}

export function noticeBody(t, { baseUrl = "", reason = "" }) {
  return [
    reason || "A customer email was added to a support ticket.",
    "",
    `Support Ticket ID: ${t.ticket_no}`,
    `Customer: ${t.customer_name} <${t.email}>`,
    `Ticket status: ${t.status}`,
    "",
    `Admin Portal ticket details: ${adminLink(t.ticket_no, baseUrl)}`,
  ].join("\n");
}

export function followUpBody(t, { author, text, baseUrl = "" }) {
  return [
    `A partner added a follow-up to ticket ${t.ticket_no}.`,
    "",
    `Portal Type: ${t.portal_type} (account ${author})`,
    `Customer Name: ${t.customer_name}`,
    "",
    "Follow-up:",
    text,
    "",
    `Admin Portal ticket details: ${adminLink(t.ticket_no, baseUrl)}`,
  ].join("\n");
}

// Confirmation sent to the customer when a request is received. Wording is deliberately short.
export const CONFIRM_SUBJECT = (ticketNo) => `We received your support request – ON THE WAY LOGISTICS – ${ticketNo}`;
export function confirmationBody(t) {
  return [
    `Hello ${t.customer_name || "there"},`,
    "",
    `We have received your support request. Your Ticket ID is ${t.ticket_no}.`,
    "",
    "Our support team will reply to this email address. Please keep the Ticket ID in your reply.",
    "",
    "ON THE WAY LOGISTICS Support",
  ].join("\n");
}
