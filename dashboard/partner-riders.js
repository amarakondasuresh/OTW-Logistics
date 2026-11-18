// Admin Portal > Client: the riders registered by each Vendor / Franchise, with a payment summary per rider.
// Pure functions (no page, no network) so they can be tested in Node; app.js draws the tables.
//
// A rider belongs to a partner when its Rider Registration was made from that partner's portal login
// (ownerLoginId = the partner's Vendor / Franchise ID, e.g. VN-000001). Payment figures come from the saved weekly
// payments of verified riders (the same rows as Payments and Reports); Total Orders uses the Reports rule.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PartnerRiders = factory();
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";
  const key = (v) => String(v ?? "").trim().toUpperCase();
  const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? 0 : Number(v));
  const totalOf = (r) =>
    r.totalOrders === null || r.totalOrders === undefined || r.totalOrders === ""
      ? num(r.lm) + num(r.primary) + num(r.club)
      : num(r.totalOrders);

  // The login IDs one partner application may own riders under.
  function ownerKeysOf(partner) {
    return [partner?.portalLogin?.loginId, partner?.appId, partner?.previousAppId]
      .map(key)
      .filter(Boolean);
  }

  // Payment summary per Rider ID from the weekly payment rows (verified rows only).
  function paymentIndex(weeklyRows) {
    const idx = new Map();
    for (const r of weeklyRows || []) {
      const id = key(r.riderId);
      if (!id || r.verificationStatus === "PENDING_VERIFICATION") continue;
      if (!idx.has(id)) idx.set(id, { weeks: 0, orders: 0, amount: 0, paid: 0, latest: "", latestStart: "" });
      const p = idx.get(id);
      p.weeks++;
      p.orders += totalOf(r);
      p.amount += num(r.amount);
      if (r.paymentStatus === "PAID") p.paid += num(r.amount);
      if (String(r.weekStart || "") >= p.latestStart) {
        p.latestStart = String(r.weekStart || "");
        p.latest = r.week || r.weekStart || "";
      }
    }
    return idx;
  }

  // One group per partner: {partner, riders, counts, totals}. Riders newest first.
  function ridersByPartner(partners, registrations, weeklyRows = []) {
    const pay = paymentIndex(weeklyRows);
    const byOwner = new Map();
    for (const r of registrations || []) {
      if (r.registrationSource !== "Vendor" && r.registrationSource !== "Franchise") continue;
      const k = key(r.ownerLoginId);
      if (!k) continue;
      if (!byOwner.has(k)) byOwner.set(k, []);
      byOwner.get(k).push(r);
    }
    return (partners || []).map((partner) => {
      const seen = new Set();
      const riders = [];
      for (const k of ownerKeysOf(partner))
        for (const r of byOwner.get(k) || [])
          if (!seen.has(r.id) && r.registrationSource === partner.type) {
            seen.add(r.id);
            riders.push({ ...r, payments: pay.get(key(r.riderId)) || null });
          }
      riders.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      const counts = { total: riders.length, APPROVED: 0, PENDING: 0, REJECTED: 0 };
      const totals = { orders: 0, amount: 0, paid: 0 };
      for (const r of riders) {
        counts[r.status] = (counts[r.status] || 0) + 1;
        if (r.payments) {
          totals.orders += r.payments.orders;
          totals.amount += r.payments.amount;
          totals.paid += r.payments.paid;
        }
      }
      return { partner, riders, counts, totals };
    });
  }

  return { ridersByPartner, paymentIndex, ownerKeysOf };
});
