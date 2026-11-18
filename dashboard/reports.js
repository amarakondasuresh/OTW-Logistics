// Reports dashboard (admin). Data comes from GET /api/admin/reports (backend/report-stats.js), which reads the
// partners' order records in the database. Every figure, chart, table and export on this page is built from that
// response, so filters apply to all of them at once.
(function () {
  const MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const COLORS = {
    prime: "#1769e0",
    club: "#16a34a",
    large: "#f59e0b",
    total: "#0f2a4a",
  };
  const STATUS_OPTIONS = [
    ["PENDING", "Pending"],
    ["PROCESSING", "Processing"],
    ["PAID", "Paid"],
    ["FAILED", "Failed"],
  ];
  const STATUS_LABEL = Object.fromEntries(STATUS_OPTIONS);
  const DEFAULT_FILTERS = {
    start: "",
    end: "",
    month: "",
    year: "",
    search: "",
    hub: "",
  };

  const S = {
    mode: "15",
    filters: { ...DEFAULT_FILTERS },
    data: null,
    error: "",
    loading: false,
    requestId: 0,
    charts: [],
    table: { q: "", sort: "start", dir: 1, page: 1, size: 10 },
  };

  const $ = (sel, root = document) => root.querySelector(sel);
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
  const fmtN = (n) => Number(n || 0).toLocaleString("en-IN");
  const fmtP = (p) => `${Number(p || 0).toFixed(1)}%`;
  const fmtM = (v) =>
    v === null || v === undefined
      ? "—"
      : "₹" +
        Number(v).toLocaleString("en-IN", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
  const fmtD = (iso) => {
    if (!iso) return "";
    const [y, m, d] = String(iso).split("-");
    return `${d}/${m}/${y}`;
  };
  const notify = (msg) => {
    if (typeof toast === "function") toast(msg);
  };

  // ---------- Layout ----------
  function shell() {
    const years = [];
    const nowYear = new Date().getFullYear();
    for (let y = nowYear; y >= 2024; y--) years.push(y);
    const f = S.filters;
    return `
<section class="rp" id="rpRoot" aria-label="Reports dashboard">
  <div class="rp-modes" role="tablist" aria-label="Reporting period">
    <button type="button" class="rp-mode ${S.mode === "15" ? "active" : ""}" data-mode="15" role="tab" aria-selected="${S.mode === "15"}">15-Day Report<small>Consecutive 1–15 and 16–end periods</small></button>
    <button type="button" class="rp-mode ${S.mode === "365" ? "active" : ""}" data-mode="365" role="tab" aria-selected="${S.mode === "365"}">365-Day Report<small>Yearly, month by month</small></button>
  </div>

  <form class="rp-filters" id="rpFilters" autocomplete="off">
    <label>Start date<input type="date" name="start" value="${esc(f.start)}"></label>
    <label>End date<input type="date" name="end" value="${esc(f.end)}"></label>
    <label>Month<select name="month"><option value="">All months</option>${MONTHS.map((m, i) => `<option value="${i + 1}" ${String(i + 1) === f.month ? "selected" : ""}>${m}</option>`).join("")}</select></label>
    <label>Year<select name="year"><option value="">Current year</option>${years.map((y) => `<option value="${y}" ${String(y) === f.year ? "selected" : ""}>${y}</option>`).join("")}</select></label>
    <label>Rider name or ID<input type="search" name="search" value="${esc(f.search)}" placeholder="e.g. WL001 or Ravi"></label>
    <label>Hub location<input type="search" name="hub" value="${esc(f.hub)}" placeholder="e.g. Palakollu"></label>
    <div class="rp-filter-actions">
      <button type="submit" class="primary">Apply Filter</button>
      <button type="button" class="ghost" id="rpReset">Reset Filter</button>
    </div>
  </form>
  <p class="rp-hint" id="rpHint">Month and Year narrow the range inside the selected year. Start and End dates override the year. Data comes from the saved Payments records.</p>

  <div id="rpStatus" role="status" aria-live="polite"></div>
  <div id="rpBody" hidden>
    <div class="rp-cards" id="rpCards"></div>

    <div class="rp-export-bar">
      <div><strong>Export the current filter results</strong><span id="rpRange" class="rp-muted"></span></div>
      <div class="rp-export-buttons">
        <button type="button" class="primary" id="rpExcel">Export to Excel</button>
        <button type="button" class="primary rp-pdf-btn" id="rpPdf">Download PDF</button>
      </div>
    </div>

    <div class="rp-grid">
      <div class="rp-card rp-chart-card">
        <div class="rp-card-head"><h3 id="rpChartTitle"></h3><span class="rp-muted">Hover a bar for exact counts and share</span></div>
        <div class="rp-chart-box"><canvas id="rpChart" aria-label="Order chart"></canvas></div>
        <div class="rp-chart-empty" id="rpChartEmpty" hidden>No orders in this period.</div>
      </div>
      <div class="rp-card">
        <div class="rp-card-head"><h3>Category share</h3><span class="rp-muted" id="rpShareNote"></span></div>
        <div id="rpShare"></div>
      </div>
    </div>

    <div class="rp-card">
      <div class="rp-card-head"><h3 id="rpPeriodTitle"></h3></div>
      <div class="rp-table-wrap"><table class="rp-table" id="rpPeriodTable"></table></div>
    </div>

    <div class="rp-card">
      <div class="rp-card-head rp-table-head">
        <h3>Rider report details</h3>
        <input type="search" id="rpTableSearch" placeholder="Filter rows by rider or hub" aria-label="Filter rider rows">
      </div>
      <div class="rp-table-wrap"><table class="rp-table" id="rpRiderTable"></table></div>
      <div class="rp-pager" id="rpPager"></div>
    </div>
  </div>
</section>`;
  }

  // ---------- Loading and rendering ----------
  function setStatus(html) {
    const el = $("#rpStatus");
    if (el) el.innerHTML = html;
  }

  function setBodyVisible(visible) {
    const body = $("#rpBody");
    if (body) body.hidden = !visible;
  }

  function destroyCharts() {
    S.charts.forEach((c) => {
      try {
        c.destroy();
      } catch (e) {
        /* chart already detached */
      }
    });
    S.charts = [];
  }

  async function load() {
    const id = ++S.requestId;
    S.loading = true;
    S.error = "";
    setBodyVisible(false);
    setStatus(
      '<div class="rp-loading"><span class="rp-spinner" aria-hidden="true"></span> Loading report from the database…</div>',
    );
    const params = new URLSearchParams({ mode: S.mode });
    Object.entries(S.filters).forEach(([k, v]) => {
      if (v) params.set(k, v);
    });
    try {
      const r = await fetch(`${PARTNER_API_BASE}/api/admin/reports?${params}`, {
        credentials: "include",
      });
      if (r.status === 401 && typeof sessionEnded === "function")
        sessionEnded();
      let out = {};
      try {
        out = await r.json();
      } catch (e) {
        /* non-JSON response */
      }
      if (!r.ok) throw new Error(out.error || "Could not load the report.");
      if (id !== S.requestId || !$("#rpRoot")) return; // a newer request started, or the page was left
      S.data = out;
      S.loading = false;
      render();
    } catch (err) {
      if (id !== S.requestId || !$("#rpRoot")) return;
      S.loading = false;
      S.error = err.message || "Could not load the report.";
      S.data = null;
      destroyCharts();
      setBodyVisible(false);
      setStatus(
        `<div class="rp-error" role="alert"><span>${esc(S.error)}</span> <button type="button" class="ghost" id="rpRetry">Try again</button></div>`,
      );
      $("#rpRetry")?.addEventListener("click", load);
    }
  }

  function render() {
    const d = S.data;
    if (!d) return;
    setStatus("");
    setBodyVisible(true);
    const isYear = d.mode === "365";
    const items = isYear ? d.months : d.periods;
    const s = d.summary;

    $("#rpRange").textContent =
      `  ·  ${fmtD(d.range.start)} to ${fmtD(d.range.end)}`;
    $("#rpCards").innerHTML = [
      ["Total Riders", fmtN(s.riders), "Unique riders with orders"],
      ["Total Orders", fmtN(s.total), "All orders in range"],
      ["Prime Orders", fmtN(s.prime), `${fmtP(s.percent.prime)} of total`],
      ["Club Orders", fmtN(s.club), `${fmtP(s.percent.club)} of total`],
      ["LM Orders", fmtN(s.large), `${fmtP(s.percent.large)} of total`],
      ["SDD Orders", fmtN(s.sdd), "Saved SDD orders in range"],
      [
        "Total Payment Amount",
        fmtM(s.amounts?.total),
        "Excel Amount, as imported",
      ],
      [
        "Total Paid",
        fmtM(s.paidAmount),
        `${fmtN(s.paymentStatus?.PAID?.count)} rider-week(s) paid`,
      ],
      [
        "Total Pending",
        fmtM(s.pendingAmount),
        `${fmtN(s.paymentStatus?.PENDING?.count)} awaiting payment`,
      ],
      [
        "Processing",
        fmtM(s.processingAmount),
        `${fmtN(s.paymentStatus?.PROCESSING?.count)} in process`,
      ],
      [
        "Failed",
        fmtM(s.failedAmount),
        `${fmtN(s.paymentStatus?.FAILED?.count)} failed`,
      ],
    ]
      .map(
        ([label, value, sub]) =>
          `<div class="rp-stat"><div class="rp-stat-label">${label}</div><div class="rp-stat-value">${value}</div><div class="rp-stat-sub">${sub}</div></div>`,
      )
      .join("");

    $("#rpChartTitle").textContent = isYear
      ? "Monthly orders by category"
      : "15-day period comparison";
    $("#rpPeriodTitle").textContent = isYear
      ? "Monthly statistics"
      : "15-day period statistics";
    $("#rpShareNote").textContent = s.total
      ? `Out of ${fmtN(s.total)} total orders`
      : "No orders in range";
    $("#rpShare").innerHTML =
      ["prime", "club", "large"]
        .map((k) => {
          const label = { prime: "Prime", club: "Club", large: "LM" }[k];
          const value = s[k];
          return `<div class="rp-share-row"><div class="rp-share-top"><span><i class="rp-dot" style="background:${COLORS[k]}"></i>${label} Orders</span><strong>${fmtN(value)} · ${fmtP(s.percent[k])}</strong></div><div class="rp-bar" role="img" aria-label="${label} ${fmtP(s.percent[k])}"><span style="width:${Math.min(100, s.percent[k])}%;background:${COLORS[k]}"></span></div></div>`;
        })
        .join("") +
      (s.total === 0
        ? '<p class="rp-empty">No orders were found for these filters. Import payment data or change the filters.</p>'
        : "");

    renderChart(items);
    renderPeriodTable(items, isYear);
    renderRiderTable();
    renderQualityNote(d);
  }

  function renderQualityNote(d) {
    const q = d.quality || {};
    const notes = [];
    if (q.skippedInvalidRecords)
      notes.push(
        `${fmtN(q.skippedInvalidRecords)} record(s) had a missing or invalid date or rider ID and were left out.`,
      );
    if (q.duplicateRecordsIgnored)
      notes.push(
        `${fmtN(q.duplicateRecordsIgnored)} duplicate rider-day record(s) were counted once.`,
      );
    if (q.totalsRaisedToMatchCategories)
      notes.push(
        `${fmtN(q.totalsRaisedToMatchCategories)} record(s) had a total lower than their categories; the total was raised to match.`,
      );
    let el = $("#rpQuality");
    if (!el) {
      el = document.createElement("p");
      el.id = "rpQuality";
      el.className = "rp-hint rp-quality";
      $("#rpBody")?.appendChild(el);
    }
    el.textContent = notes.join(" ");
    el.hidden = notes.length === 0;
  }

  function renderChart(items) {
    destroyCharts();
    const canvas = $("#rpChart");
    const empty = $("#rpChartEmpty");
    const total = items.reduce((n, i) => n + i.total, 0);
    if (!items.length || total === 0) {
      canvas.hidden = true;
      empty.hidden = false;
      return;
    }
    canvas.hidden = false;
    empty.hidden = true;
    if (!window.Chart) {
      canvas.hidden = true;
      empty.hidden = false;
      empty.textContent =
        "The chart library could not load. Check the internet connection and refresh.";
      return;
    }
    const labels = items.map((i) => i.label);
    const datasets = [
      {
        label: "Prime Orders",
        key: "prime",
        data: items.map((i) => i.prime),
        backgroundColor: COLORS.prime,
      },
      {
        label: "Club Orders",
        key: "club",
        data: items.map((i) => i.club),
        backgroundColor: COLORS.club,
      },
      {
        label: "LM Orders",
        key: "large",
        data: items.map((i) => i.large),
        backgroundColor: COLORS.large,
      },
      {
        label: "Total Orders",
        key: "total",
        data: items.map((i) => i.total),
        backgroundColor: COLORS.total,
      },
    ];
    const chart = new Chart(canvas, {
      type: "bar",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { grid: { display: false }, ticks: { color: "#64748b" } },
          y: {
            beginAtZero: true,
            title: { display: true, text: "Number of orders" },
            ticks: { precision: 0, color: "#64748b" },
          },
        },
        plugins: {
          legend: {
            position: "bottom",
            labels: { usePointStyle: true, color: "#17304f" },
          },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const ds = datasets[ctx.datasetIndex];
                const item = items[ctx.dataIndex];
                const v = ctx.parsed.y;
                if (ds.key === "total") return `Total Orders: ${fmtN(v)}`;
                const share = item.total ? (v / item.total) * 100 : 0;
                return `${ds.label}: ${fmtN(v)} (${share.toFixed(1)}% of ${fmtN(item.total)})`;
              },
            },
          },
        },
      },
    });
    S.charts.push(chart);
  }

  function renderPeriodTable(items, isYear) {
    const head = [
      isYear ? "Month" : "Period",
      "Start Date",
      "End Date",
      "Total Riders",
      "Total Orders",
      "Prime Orders",
      "Club Orders",
      "LM Orders",
      "Prime %",
      "Club %",
      "LM %",
    ];
    const body = items
      .map(
        (i) => `<tr>
      <td>${esc(i.label)}</td><td>${fmtD(i.start)}</td><td>${fmtD(i.end)}</td><td class="num">${fmtN(i.riders)}</td>
      <td class="num">${fmtN(i.total)}</td><td class="num">${fmtN(i.prime)}</td><td class="num">${fmtN(i.club)}</td><td class="num">${fmtN(i.large)}</td>
      <td class="num">${fmtP(i.percent.prime)}</td><td class="num">${fmtP(i.percent.club)}</td><td class="num">${fmtP(i.percent.large)}</td></tr>`,
      )
      .join("");
    const t = S.data.summary;
    const foot = `<tr class="rp-total"><td>Total</td><td></td><td></td><td class="num">${fmtN(t.riders)}</td><td class="num">${fmtN(t.total)}</td><td class="num">${fmtN(t.prime)}</td><td class="num">${fmtN(t.club)}</td><td class="num">${fmtN(t.large)}</td><td class="num">${fmtP(t.percent.prime)}</td><td class="num">${fmtP(t.percent.club)}</td><td class="num">${fmtP(t.percent.large)}</td></tr>`;
    $("#rpPeriodTable").innerHTML =
      `<thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${body || `<tr><td colspan="${head.length}" class="rp-empty-cell">No periods in this range.</td></tr>`}</tbody><tfoot>${foot}</tfoot>`;
  }

  // ---------- Rider table: search, sort, pagination ----------
  // Rider ID is not a column: it is used internally only. The one ID shown is the Order ID.
  const RIDER_COLS = [
    ["orderId", "Order ID"],
    ["riderName", "Rider Name"],
    ["hub", "Hub Location"],
    ["start", "Week Start"],
    ["end", "Week End"],
    ["days", "Days"],
    ["total", "Total Orders"],
    ["large", "LM Orders"],
    ["prime", "Prime Orders"],
    ["club", "Club Orders"],
    ["sdd", "SDD Orders"],
    ["amount", "Total Amount"],
    ["primePct", "Prime %"],
    ["clubPct", "Club %"],
    ["largePct", "LM %"],
    ["status", "Payment Status"],
  ];

  function filteredRows() {
    const rows = S.data?.rows || [];
    const q = S.table.q.trim().toLowerCase();
    const list = q
      ? rows.filter((r) =>
          `${r.riderId} ${r.riderName} ${r.hub}`.toLowerCase().includes(q),
        )
      : rows.slice();
    const key = S.table.sort,
      dir = S.table.dir;
    list.sort((a, b) => {
      const x = a[key],
        y = b[key];
      const cmp =
        typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x ?? "").localeCompare(String(y ?? ""), undefined, {
              numeric: true,
            });
      return (
        cmp * dir ||
        String(a.orderId).localeCompare(String(b.orderId), undefined, {
          numeric: true,
        })
      );
    });
    return list;
  }

  // The status is saved on the server (one rider-week). Changing it here is the only way the Admin sets it.
  function statusCell(r) {
    if (!r.rowId) return '<span class="rp-muted">—</span>';
    const opts = STATUS_OPTIONS.map(
      ([v, l]) =>
        `<option value="${v}" ${r.status === v ? "selected" : ""}>${l}</option>`,
    ).join("");
    return `<select class="rp-status-select" data-row-id="${esc(r.rowId)}" data-status="${esc(r.status)}" aria-label="Payment status for ${esc(r.riderName)}, week of ${fmtD(r.start)}">${opts}</select>`;
  }

  function renderRiderTable() {
    const list = filteredRows();
    const size = S.table.size;
    const pages = Math.max(1, Math.ceil(list.length / size));
    if (S.table.page > pages) S.table.page = pages;
    const start = (S.table.page - 1) * size;
    const pageRows = list.slice(start, start + size);
    const head = RIDER_COLS.map(([key, label]) => {
      const active = S.table.sort === key;
      const arrow = active ? (S.table.dir === 1 ? " ▲" : " ▼") : "";
      return `<th><button type="button" class="rp-sort" data-sort="${key}" aria-label="Sort by ${label}">${label}${arrow}</button></th>`;
    }).join("");
    const body = pageRows
      .map(
        (r, i) => `<tr>
      <td class="num">${start + i + 1}</td><td>${esc(r.orderId)}</td><td>${esc(r.riderName)}</td><td>${esc(r.hub)}</td>
      <td>${fmtD(r.start)}</td><td>${fmtD(r.end)}</td><td class="num">${fmtN(r.days)}</td><td class="num">${fmtN(r.total)}</td>
      <td class="num">${fmtN(r.large)}</td><td class="num">${fmtN(r.prime)}</td><td class="num">${fmtN(r.club)}</td>
      <td class="num">${fmtN(r.sdd)}</td><td class="num">${fmtM(r.amount)}</td><td class="num">${fmtP(r.primePct)}</td>
      <td class="num">${fmtP(r.clubPct)}</td><td class="num">${fmtP(r.largePct)}</td><td>${statusCell(r)}</td></tr>`,
      )
      .join("");
    $("#rpRiderTable").innerHTML =
      `<thead><tr><th>S.No</th>${head}</tr></thead><tbody>${body || `<tr><td colspan="${RIDER_COLS.length + 1}" class="rp-empty-cell">${S.data?.rows?.length ? "No rows match the table search." : "No rider orders in this range."}</td></tr>`}</tbody>`;
    $("#rpPager").innerHTML = list.length
      ? `<span class="rp-muted">Showing ${start + 1}–${Math.min(start + size, list.length)} of ${fmtN(list.length)} rows</span>
         <div class="rp-pager-buttons"><button type="button" class="ghost" data-page="prev" ${S.table.page <= 1 ? "disabled" : ""}>Previous</button>
         <span>Page ${S.table.page} of ${pages}</span>
         <button type="button" class="ghost" data-page="next" ${S.table.page >= pages ? "disabled" : ""}>Next</button></div>`
      : "";
  }

  // ---------- Exports (built from the same response as the screen) ----------
  function exportFileBase() {
    const d = S.data;
    return `OTW_Report_${d.mode}-Day_${d.range.start}_to_${d.range.end}`;
  }

  function exportExcel() {
    const d = S.data;
    if (!d) return notify("Load a report first.");
    if (!window.XLSX)
      return notify(
        "The Excel library could not load. Check the internet connection and try again.",
      );
    const isYear = d.mode === "365";
    const s = d.summary;
    const wb = XLSX.utils.book_new();

    const summary = [
      ["ON THE WAY LOGISTICS - Reports"],
      ["Report type", isYear ? "365-Day Report (Yearly)" : "15-Day Report"],
      ["Date range", `${fmtD(d.range.start)} to ${fmtD(d.range.end)}`],
      ["Generated", new Date(d.generatedAt).toLocaleString("en-IN")],
      [],
      ["Metric", "Value"],
      ["Total Riders", s.riders],
      ["Total Orders", s.total],
      ["Prime Orders", s.prime],
      ["Club Orders", s.club],
      ["LM Orders", s.large],
      ["SDD Orders", s.sdd],
      ["Total Amount", s.amounts?.total ?? ""],
      [],
      ["Category", "Orders", "Percentage of total orders"],
      ["Prime", s.prime, s.percent.prime / 100],
      ["Club", s.club, s.percent.club / 100],
      ["LM", s.large, s.percent.large / 100],
    ];
    const sheet1 = XLSX.utils.aoa_to_sheet(summary);
    sheet1["!cols"] = [{ wch: 26 }, { wch: 22 }, { wch: 26 }];
    XLSX.utils.book_append_sheet(wb, sheet1, "Yearly Summary");

    const items = isYear ? d.months : d.periods;
    const periodSheet = [
      [
        isYear ? "Month" : "Period",
        "Start Date",
        "End Date",
        "Total Riders",
        "Total Orders",
        "Prime Orders",
        "Club Orders",
        "LM Orders",
        "Prime %",
        "Club %",
        "LM %",
      ],
      ...items.map((i) => [
        i.label,
        fmtD(i.start),
        fmtD(i.end),
        i.riders,
        i.total,
        i.prime,
        i.club,
        i.large,
        i.percent.prime / 100,
        i.percent.club / 100,
        i.percent.large / 100,
      ]),
    ];
    const sheet2 = XLSX.utils.aoa_to_sheet(periodSheet);
    sheet2["!cols"] = Array.from({ length: 11 }, () => ({ wch: 14 }));
    XLSX.utils.book_append_sheet(
      wb,
      sheet2,
      isYear ? "Monthly Summary" : "15-Day Summary",
    );

    const detail = [
      [
        "S.No",
        "Order ID",
        "Rider Name",
        "Hub Location",
        "Week Start",
        "Week End",
        "Days",
        "Total Orders",
        "LM Orders",
        "Prime Orders",
        "Club Orders",
        "SDD Orders",
        "Total Amount",
        "Prime %",
        "Club %",
        "LM %",
      ],
      ...(d.rows || []).map((r, i) => [
        i + 1,
        r.orderId,
        r.riderName,
        r.hub,
        fmtD(r.start),
        fmtD(r.end),
        r.days,
        r.total,
        r.large,
        r.prime,
        r.club,
        r.sdd,
        r.amount ?? "",
        r.primePct / 100,
        r.clubPct / 100,
        r.largePct / 100,
      ]),
    ];
    const sheet3 = XLSX.utils.aoa_to_sheet(detail);
    sheet3["!cols"] = [
      { wch: 7 },
      { wch: 24 },
      { wch: 30 },
      { wch: 18 },
      { wch: 14 },
      { wch: 14 },
      { wch: 8 },
      { wch: 14 },
      { wch: 12 },
      { wch: 14 },
      { wch: 14 },
      { wch: 12 },
      { wch: 14 },
      { wch: 10 },
      { wch: 10 },
      { wch: 10 },
    ];
    XLSX.utils.book_append_sheet(wb, sheet3, "Rider Details");

    XLSX.writeFile(wb, `${exportFileBase()}.xlsx`);
    notify("Excel report downloaded");
  }

  function loadImageDataUrl(url) {
    return fetch(url)
      .then((r) => r.blob())
      .then(
        (blob) =>
          new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result);
            fr.onerror = reject;
            fr.readAsDataURL(blob);
          }),
      );
  }

  async function exportPdf() {
    const d = S.data;
    if (!d) return notify("Load a report first.");
    const JsPDF = window.jspdf && window.jspdf.jsPDF;
    if (!JsPDF)
      return notify(
        "The PDF library could not load. Check the internet connection and try again.",
      );
    const isYear = d.mode === "365";
    const s = d.summary;
    const doc = new JsPDF({ unit: "pt", format: "a4" });
    const W = doc.internal.pageSize.getWidth();
    const M = 36;
    const brand = [15, 42, 74];

    // Header band with logo and company name
    doc.setFillColor(...brand);
    doc.rect(0, 0, W, 84, "F");
    try {
      const logo = await loadImageDataUrl("logo.jpg");
      doc.addImage(logo, "JPEG", M, 14, 128, 56);
    } catch (e) {
      /* logo is optional in the PDF */
    }
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(17);
    doc.text("ON THE WAY LOGISTICS", W - M, 38, { align: "right" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.text(isYear ? "365-Day Yearly Report" : "15-Day Report", W - M, 58, {
      align: "right",
    });

    // Period and filters
    doc.setTextColor(23, 48, 79);
    doc.setFontSize(10);
    let y = 106;
    const f = d.filters || {};
    const filterText =
      [
        f.month ? `Month: ${MONTHS[Number(f.month) - 1]}` : "",
        f.year ? `Year: ${f.year}` : "",
        f.search ? `Rider: ${f.search}` : "",
        f.hub ? `Hub: ${f.hub}` : "",
      ]
        .filter(Boolean)
        .join("   ·   ") || "No extra filters";
    doc.setFont("helvetica", "bold");
    doc.text(
      `Reporting period: ${fmtD(d.range.start)} to ${fmtD(d.range.end)}`,
      M,
      y,
    );
    doc.setFont("helvetica", "normal");
    y += 15;
    doc.text(`Filters: ${filterText}`, M, y);
    y += 15;
    doc.text(
      `Report generated: ${new Date(d.generatedAt).toLocaleString("en-IN")}`,
      M,
      y,
    );
    y += 14;

    // Summary cards as a table
    doc.autoTable({
      startY: y + 6,
      margin: { left: M, right: M },
      head: [
        [
          "Total Riders",
          "Total Orders",
          "Prime Orders",
          "Club Orders",
          "LM Orders",
        ],
      ],
      body: [
        [
          fmtN(s.riders),
          fmtN(s.total),
          fmtN(s.prime),
          fmtN(s.club),
          fmtN(s.large),
        ],
      ],
      theme: "grid",
      headStyles: { fillColor: [23, 105, 224], halign: "center" },
      bodyStyles: { halign: "center", fontSize: 13, fontStyle: "bold" },
    });
    y = doc.lastAutoTable.finalY + 14;

    doc.autoTable({
      startY: y,
      margin: { left: M, right: M },
      head: [["Category", "Orders", "Share of total orders"]],
      body: [
        ["Prime", fmtN(s.prime), fmtP(s.percent.prime)],
        ["Club", fmtN(s.club), fmtP(s.percent.club)],
        ["LM", fmtN(s.large), fmtP(s.percent.large)],
        ["Total", fmtN(s.total), "100%"],
      ],
      theme: "striped",
      headStyles: { fillColor: brand },
    });
    y = doc.lastAutoTable.finalY + 16;

    // Chart image, if drawn
    const chart = S.charts[0];
    if (chart) {
      const img = chart.toBase64Image("image/png", 1);
      const cw = W - 2 * M;
      const ch = cw * (chart.height / chart.width);
      if (y + ch > 760) {
        doc.addPage();
        y = 40;
      }
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.text(
        isYear ? "Monthly orders by category" : "15-day period comparison",
        M,
        y,
      );
      doc.addImage(img, "PNG", M, y + 6, cw, ch);
      y += ch + 22;
    }

    const items = isYear ? d.months : d.periods;
    doc.autoTable({
      startY: y,
      margin: { left: M, right: M },
      head: [
        [
          isYear ? "Month" : "Period",
          "Start",
          "End",
          "Riders",
          "Total",
          "Prime",
          "Club",
          "LM",
          "Prime %",
          "Club %",
          "LM %",
        ],
      ],
      body: items.map((i) => [
        i.label,
        fmtD(i.start),
        fmtD(i.end),
        fmtN(i.riders),
        fmtN(i.total),
        fmtN(i.prime),
        fmtN(i.club),
        fmtN(i.large),
        fmtP(i.percent.prime),
        fmtP(i.percent.club),
        fmtP(i.percent.large),
      ]),
      theme: "striped",
      headStyles: { fillColor: brand },
      styles: { fontSize: 8 },
    });

    const rows = d.rows || [];
    doc.autoTable({
      startY: doc.lastAutoTable.finalY + 18,
      margin: { left: M, right: M },
      head: [
        [
          "S.No",
          "Order ID",
          "Rider Name",
          "Hub",
          "Start",
          "End",
          "Days",
          "Total",
          "LM",
          "Prime",
          "Club",
          "SDD",
          "Amount",
          "Prime %",
          "Club %",
          "LM %",
        ],
      ],
      body: rows.map((r, i) => [
        i + 1,
        r.orderId,
        r.riderName,
        r.hub,
        fmtD(r.start),
        fmtD(r.end),
        fmtN(r.days),
        fmtN(r.total),
        fmtN(r.large),
        fmtN(r.prime),
        fmtN(r.club),
        fmtN(r.sdd),
        fmtM(r.amount),
        fmtP(r.primePct),
        fmtP(r.clubPct),
        fmtP(r.largePct),
      ]),
      theme: "striped",
      headStyles: { fillColor: brand },
      styles: { fontSize: 7.5 },
      didDrawPage: () => {
        doc.setFontSize(8);
        doc.setTextColor(104, 115, 134);
        doc.text(
          `On The Way Logistics · Generated ${new Date().toLocaleDateString("en-IN")}`,
          M,
          doc.internal.pageSize.getHeight() - 16,
        );
      },
    });

    const pages = doc.internal.getNumberOfPages();
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p);
      doc.setFontSize(8);
      doc.setTextColor(104, 115, 134);
      doc.text(
        `Page ${p} of ${pages}`,
        W - M,
        doc.internal.pageSize.getHeight() - 16,
        { align: "right" },
      );
    }
    doc.save(`${exportFileBase()}.pdf`);
    notify("PDF report downloaded");
  }

  // ---------- Events ----------
  function readFilters(form) {
    const fd = new FormData(form);
    const out = { ...DEFAULT_FILTERS };
    Object.keys(out).forEach((k) => {
      out[k] = String(fd.get(k) || "").trim();
    });
    return out;
  }

  function validateRange(f) {
    if (f.start && f.end && f.start > f.end)
      return "The start date cannot be after the end date.";
    return "";
  }

  function bind() {
    const root = $("#rpRoot");
    if (!root) return;

    root.addEventListener("click", (e) => {
      const modeBtn = e.target.closest("[data-mode]");
      if (modeBtn && modeBtn.classList.contains("rp-mode")) {
        if (S.mode === modeBtn.dataset.mode) return;
        S.mode = modeBtn.dataset.mode;
        S.table.page = 1;
        root.querySelectorAll(".rp-mode").forEach((b) => {
          const on = b.dataset.mode === S.mode;
          b.classList.toggle("active", on);
          b.setAttribute("aria-selected", String(on));
        });
        load();
        return;
      }
      const sortBtn = e.target.closest(".rp-sort");
      if (sortBtn) {
        const key = sortBtn.dataset.sort;
        if (S.table.sort === key) S.table.dir *= -1;
        else {
          S.table.sort = key;
          S.table.dir = 1;
        }
        renderRiderTable();
        return;
      }
      const pageBtn = e.target.closest("[data-page]");
      if (pageBtn && !pageBtn.disabled) {
        S.table.page += pageBtn.dataset.page === "next" ? 1 : -1;
        renderRiderTable();
        return;
      }
      if (e.target.closest("#rpReset")) {
        S.filters = { ...DEFAULT_FILTERS };
        S.table = { ...S.table, q: "", page: 1 };
        // form.reset() would restore the values rendered last time, so clear each field explicitly.
        [...$("#rpFilters").elements].forEach((el) => {
          if (el.name) el.value = "";
        });
        load();
        return;
      }
      if (e.target.closest("#rpExcel")) return exportExcel();
      if (e.target.closest("#rpPdf")) return exportPdf();
    });

    root.querySelector("#rpFilters").addEventListener("submit", (e) => {
      e.preventDefault();
      const f = readFilters(e.currentTarget);
      const err = validateRange(f);
      if (err) return notify(err);
      S.filters = f;
      S.table.page = 1;
      load();
    });

    root.addEventListener("change", async (e) => {
      const sel = e.target.closest
        ? e.target.closest(".rp-status-select")
        : null;
      if (!sel) return;
      const rowId = Number(sel.dataset.rowId);
      const previous = sel.dataset.status;
      const next = sel.value;
      sel.disabled = true;
      try {
        const r = await fetch(
          `${PARTNER_API_BASE}/api/admin/weekly-payments/${encodeURIComponent(rowId)}/status`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: next }),
          },
        );
        if (r.status === 401 && typeof sessionEnded === "function")
          sessionEnded();
        let out = {};
        try {
          out = await r.json();
        } catch (err) {
          /* non-JSON response */
        }
        if (!r.ok)
          throw new Error(out.error || "Could not update the payment status.");
        notify(`Payment status set to ${STATUS_LABEL[next]}.`);
        if (typeof weeklyStore !== "undefined") weeklyStore.loadedAt = 0; // Dashboard / Payments reload the rows
        await load(); // refresh every figure from the saved data
      } catch (err) {
        sel.value = previous;
        notify(err.message || "Could not update the payment status.");
      } finally {
        sel.disabled = false;
      }
    });

    $("#rpTableSearch").addEventListener("input", (e) => {
      S.table.q = e.target.value;
      S.table.page = 1;
      renderRiderTable();
    });
  }

  // Public entry point, called by app.js when the Reports page is shown.
  window.OTWReports = {
    mount(container) {
      destroyCharts();
      container.innerHTML = shell();
      bind();
      load();
    },
    unmount() {
      destroyCharts();
      S.requestId++;
    },
  };
})();
