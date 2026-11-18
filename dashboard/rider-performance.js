// Rider Performance Dashboard page: reads the uploaded Excel file with SheetJS and shows the results.
// All calculations are in rider-performance-core.js (RiderPerf). This file only reads files and draws the page.
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const state = {
    fileName: "",
    loadedAt: null,
    result: null,
    records: [],
    periods: { weeks: [], dates: [] },
  };

  const esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const num = (v) => Number(v || 0).toLocaleString("en-IN");
  const money = (v) =>
    "₹" +
    Number(v || 0).toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  function currentFilter() {
    return { mode: $("#mode").value, value: $("#period").value };
  }

  function refreshPeriodOptions() {
    const mode = $("#mode").value,
      sel = $("#period");
    if (mode === "all") {
      sel.innerHTML = '<option value="">All dates</option>';
      sel.disabled = true;
      return;
    }
    const list = mode === "week" ? state.periods.weeks : state.periods.dates;
    sel.disabled = !list.length;
    sel.innerHTML = list.length
      ? list
          .map((p) => `<option value="${esc(p.key)}">${esc(p.label)}</option>`)
          .join("")
      : `<option value="">No ${mode === "week" ? "weeks" : "dates"} in this file</option>`;
  }

  function card(label, value, hi) {
    return `<div class="card${hi ? " hi" : ""}"><div class="k">${esc(label)}</div><div class="v">${value}</div></div>`;
  }

  function renderCards(t, label) {
    $("#cards").innerHTML =
      [
        card("Total Number of Riders", num(t.riders)),
        card("Total Weekly Orders (All Riders)", num(t.totalOrders)),
        card("Total Large Orders (All Riders)", num(t.large)),
        card("Total Prime Orders (All Riders)", num(t.prime)),
        card("Total Club Orders (All Riders)", num(t.club)),
        card("Total SDD Orders (All Riders)", num(t.sdd)),
        card("Total FM Orders (All Riders)", num(t.fm)),
        card("Total RTS Orders (All Riders)", num(t.rts)),
        card("Grand Total Amount (All Riders)", money(t.amount), true),
      ].join("") +
      `<div class="muted" style="grid-column:1/-1">Period: <b>${esc(label)}</b></div>`;
  }

  function renderRiders(recs, mode, value) {
    const byRider = new Map();
    for (const r of recs) {
      if (!byRider.has(r.riderKey)) byRider.set(r.riderKey, []);
      byRider.get(r.riderKey).push(r);
    }
    const all = RiderPerf.riderRows(recs);
    const shown = RiderPerf.searchRows(all, $("#search").value);
    $("#detailsMeta").textContent =
      `${shown.length} of ${all.length} riders shown. Search filters this table only; the cards above always cover all riders in the period.`;
    if (!shown.length) {
      $("#riderRows").innerHTML =
        `<tr><td colspan="11" class="empty">${all.length ? "No rider matches the search." : "No riders for this period."}</td></tr>`;
      return;
    }
    $("#riderRows").innerHTML = shown
      .map((r) => {
        const dateLabel = RiderPerf.periodLabel(
          mode,
          value,
          byRider.get(r.riderKey) || [],
        );
        return `<tr>
        <td class="l">${esc(r.riderId || "—")}</td><td class="l">${esc(r.riderName)}</td><td class="l">${esc(dateLabel)}</td>
        <td>${num(r.totalOrders)}</td><td>${num(r.large)}</td><td>${num(r.prime)}</td><td>${num(r.club)}</td>
        <td>${num(r.sdd)}</td><td>${num(r.fm)}</td><td>${num(r.rts)}</td><td><b>${money(r.amount)}</b></td>
      </tr>`;
      })
      .join("");
  }

  function weeklyRowHtml(w, selected) {
    return `<tr data-week="${esc(w.weekKey)}" class="${selected ? "selected" : ""}" style="cursor:pointer">
      <td class="l">${esc(w.label)}</td><td>${num(w.riders)}</td><td>${num(w.totalOrders)}</td><td>${num(w.large)}</td>
      <td>${num(w.prime)}</td><td>${num(w.club)}</td><td>${num(w.sdd)}</td><td>${num(w.fm)}</td><td>${num(w.rts)}</td>
      <td><b>${money(w.amount)}</b></td></tr>`;
  }

  function renderWeekly(f) {
    const weeks = RiderPerf.weeklyReport(state.records);
    const overall = RiderPerf.summarize(state.records);
    if (!weeks.length && !state.records.length) {
      $("#weeklyRows").innerHTML =
        '<tr><td colspan="10" class="empty">No weekly data yet.</td></tr>';
      return;
    }
    const body = weeks
      .map((w) => weeklyRowHtml(w, f.mode === "week" && f.value === w.weekKey))
      .join("");
    const overallRow = `<tr><td class="l">Overall (all dates)</td><td>${num(overall.riders)}</td><td>${num(overall.totalOrders)}</td>
      <td>${num(overall.large)}</td><td>${num(overall.prime)}</td><td>${num(overall.club)}</td><td>${num(overall.sdd)}</td>
      <td>${num(overall.fm)}</td><td>${num(overall.rts)}</td><td><b>${money(overall.amount)}</b></td></tr>`;
    $("#weeklyRows").innerHTML =
      (body ||
        '<tr><td colspan="10" class="empty">No dated rows, so no weekly report.</td></tr>') +
      overallRow;
  }

  function renderNotice() {
    const r = state.result;
    if (!r) {
      $("#notice").innerHTML = "";
      return;
    }
    const list = (items) =>
      items.length
        ? `<ul>${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`
        : "";
    const skipped = r.skipped.map((s) => `Row ${s.row}: ${s.reason}`);
    const ignored = (r.ignoredSheets || []).map(
      (s) => `Sheet "${s.name}": ${s.reason}`,
    );
    const body = [...r.warnings, ...ignored, ...skipped.slice(0, 30)];
    const more =
      skipped.length > 30
        ? `<div class="muted">…and ${skipped.length - 30} more rows.</div>`
        : "";
    $("#notice").innerHTML = body.length
      ? `<div class="notice"><details class="warn"><summary>${body.length} note(s) about this file. Open to review.</summary>${list(body)}${more}</details></div>`
      : "";
  }

  function render() {
    const f = currentFilter();
    const recs = state.records.length
      ? RiderPerf.filterRecords(state.records, f)
      : [];
    const label = !state.records.length
      ? "No file loaded"
      : f.mode === "all" || f.value
        ? RiderPerf.periodLabel(f.mode, f.value, recs)
        : "No data for this period";
    renderCards(RiderPerf.summarize(recs), label);
    renderRiders(recs, f.mode, f.value);
    renderWeekly(f);
    renderNotice();
    $("#exportBtn").disabled = !state.records.length;
  }

  function showError(message) {
    $("#notice").innerHTML =
      `<div class="notice error">${esc(message)} The dashboard still shows the previous file, if there was one.</div>`;
  }

  async function handleFile(file) {
    try {
      if (!window.XLSX)
        throw new Error(
          "The Excel reader could not load. Check the internet connection and try again.",
        );
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
      const sheets = wb.SheetNames.map((name) => ({
        name,
        rows: XLSX.utils.sheet_to_json(wb.Sheets[name], {
          header: 1,
          raw: true,
          defval: null,
          blankrows: false,
        }),
      }));
      const result = RiderPerf.parseWorkbook(sheets);
      if (!result.ok) {
        showError(result.error);
        return;
      }

      state.result = result;
      state.records = result.records;
      state.fileName = file.name;
      state.loadedAt = new Date();
      state.periods = RiderPerf.listPeriods(result.records);

      const riders = RiderPerf.riderRows(result.records).length;
      $("#fileTitle").textContent = file.name;
      $("#fileMeta").textContent =
        `Sheet "${result.sheetName}" · ${result.records.length} rows read · ${riders} riders · loaded ${state.loadedAt.toLocaleTimeString("en-IN")}`;
      $("#mode").value = "all";
      refreshPeriodOptions();
      render();
    } catch (err) {
      showError(`Could not read this file: ${err.message}.`);
    }
  }

  function exportExcel() {
    const f = currentFilter();
    const recs = RiderPerf.filterRecords(state.records, f);
    const label = RiderPerf.periodLabel(f.mode, f.value, recs);
    const rows = RiderPerf.riderRows(recs);
    const byRider = new Map();
    recs.forEach((r) => {
      if (!byRider.has(r.riderKey)) byRider.set(r.riderKey, []);
      byRider.get(r.riderKey).push(r);
    });
    const t = RiderPerf.summarize(recs);
    const wb = XLSX.utils.book_new();
    const detail = [
      [
        "Rider ID",
        "Rider Name",
        "Date",
        "Total Weekly Orders",
        "Large Orders",
        "Prime Orders (PM)",
        "Club Orders",
        "SDD Orders",
        "FM Orders",
        "RTS Orders",
        "Total Amount",
      ],
    ];
    rows.forEach((r) =>
      detail.push([
        r.riderId,
        r.riderName,
        RiderPerf.periodLabel(f.mode, f.value, byRider.get(r.riderKey) || []),
        r.totalOrders,
        r.large,
        r.prime,
        r.club,
        r.sdd,
        r.fm,
        r.rts,
        r.amount,
      ]),
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet(detail),
      "Rider Details",
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["Period", label],
        ["Total Number of Riders", t.riders],
        ["Total Weekly Orders (All Riders)", t.totalOrders],
        ["Total Large Orders (All Riders)", t.large],
        ["Total Prime Orders (All Riders)", t.prime],
        ["Total Club Orders (All Riders)", t.club],
        ["Total SDD Orders (All Riders)", t.sdd],
        ["Total FM Orders (All Riders)", t.fm],
        ["Total RTS Orders (All Riders)", t.rts],
        ["Grand Total Amount (All Riders)", t.amount],
      ]),
      "Combined Summary",
    );
    const weekly = [
      [
        "Week (Mon-Sun)",
        "Riders",
        "Total Weekly Orders",
        "Large",
        "Prime (PM)",
        "Club",
        "SDD",
        "FM",
        "RTS",
        "Total Amount",
      ],
    ];
    RiderPerf.weeklyReport(state.records).forEach((w) =>
      weekly.push([
        w.label,
        w.riders,
        w.totalOrders,
        w.large,
        w.prime,
        w.club,
        w.sdd,
        w.fm,
        w.rts,
        w.amount,
      ]),
    );
    const o = RiderPerf.summarize(state.records);
    weekly.push([
      "Overall (all dates)",
      o.riders,
      o.totalOrders,
      o.large,
      o.prime,
      o.club,
      o.sdd,
      o.fm,
      o.rts,
      o.amount,
    ]);
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet(weekly),
      "Weekly and Overall",
    );
    const suffix = f.mode === "all" ? "overall" : f.value;
    XLSX.writeFile(wb, `rider-performance-${suffix}.xlsx`);
  }

  // events
  $("#fileInput").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (f) handleFile(f);
    e.target.value = "";
  });
  const dz = $("#dropzone");
  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add("over");
    }),
  );
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove("over");
    }),
  );
  dz.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  });
  $("#mode").addEventListener("change", () => {
    refreshPeriodOptions();
    render();
  });
  $("#period").addEventListener("change", render);
  $("#search").addEventListener("input", render);
  $("#exportBtn").addEventListener("click", exportExcel);
  $("#weeklyRows").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-week]");
    if (!tr) return;
    $("#mode").value = "week";
    refreshPeriodOptions();
    $("#period").value = tr.dataset.week;
    render();
  });
  refreshPeriodOptions();
  render();
})();
