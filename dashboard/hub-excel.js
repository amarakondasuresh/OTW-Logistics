/* Hub Management: reading spreadsheet rows.
   The browser reads the file (SheetJS for .xlsx / .xls, the CSV reader below for .csv) into a grid of cells.
   These functions find the header row, map the columns to hub fields and tidy each cell.
   The server checks every value again before anything is saved. This file has no page or server access. */
(function (root) {
  "use strict";

  // Accepted column names (compared without spaces, dashes or capitals). Several spellings are allowed
  // so the Excel master sheet can keep its own headings.
  var HEADER_ALIASES = {
    hiName: [
      "hubinchargefullname",
      "inchargefullname",
      "hubincharge",
      "inchargename",
      "hiname",
      "hi",
      "hubinchargename",
    ],
    phone: ["phonenumber", "phone", "phoneno", "mobilenumber", "mobile"],
    name: ["hubname", "name", "hub"],
    location: ["hublocation", "location", "area"],
    address: ["hubaddress", "address", "completeaddress", "fulladdress"],
    pincode: ["hubpincode", "pincode", "pin", "postalcode", "zipcode"],
    city: ["city", "citytown", "town"],
    district: ["district"],
    state: ["state"],
    contactNumber: [
      "hubcontactnumber",
      "contactnumber",
      "hubcontact",
      "contact",
    ],
    email: ["hubemailid", "hubemail", "emailid", "email", "mailid"],
    manager: ["hubmanagername", "hubmanager", "managername", "manager"],
    openingDate: [
      "hubopeningdate",
      "openingdate",
      "dateofopening",
      "openeddate",
      "opendate",
    ],
    status: ["hubstatus", "status"],
    url: ["huburl", "hublink", "url", "website", "link"],
    code: ["hubcode", "code"],
    pod: ["pod"],
    region: ["region", "zone"],
  };
  var FIELD_KEYS = Object.keys(HEADER_ALIASES);
  var KEY_BY_HEADER = {};
  FIELD_KEYS.forEach(function (key) {
    HEADER_ALIASES[key].forEach(function (alias) {
      KEY_BY_HEADER[alias] = key;
    });
  });

  function headerKey(cell) {
    var text = String(cell === null || cell === undefined ? "" : cell)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    return Object.prototype.hasOwnProperty.call(KEY_BY_HEADER, text)
      ? KEY_BY_HEADER[text]
      : null;
  }

  // Excel stores dates as day numbers counted from 30 Dec 1899.
  function excelSerialToIso(serial) {
    var d = new Date(Math.round((serial - 25569) * 86400000));
    return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  }

  // A date cell arrives as a JavaScript Date. Midnight in UTC means the spreadsheet holds that UTC date;
  // any other time means the date was built in local time, so the local date is used.
  function dateToIso(d) {
    if (isNaN(d.getTime())) return "";
    var pad = function (n) {
      return String(n).padStart(2, "0");
    };
    if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) {
      return (
        d.getUTCFullYear() +
        "-" +
        pad(d.getUTCMonth() + 1) +
        "-" +
        pad(d.getUTCDate())
      );
    }
    return (
      d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
    );
  }

  function cellText(value, key) {
    if (value === null || value === undefined) return "";
    if (value instanceof Date) return dateToIso(value);
    if (typeof value === "number") {
      if (!isFinite(value)) return "";
      if (key === "openingDate" && value > 20000 && value < 80000)
        return excelSerialToIso(value);
      return String(value);
    }
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    return String(value).replace(/\s+/g, " ").trim();
  }

  // Splits CSV text into rows of cells. Handles quoted cells, doubled quotes, line breaks inside quotes,
  // a byte-order mark, and comma, semicolon or tab as the separator.
  function parseCsvGrid(text) {
    var src = String(text || "").replace(/^\uFEFF/, "");
    var firstLine =
      src.split(/\r?\n/).find(function (l) {
        return l.trim() !== "";
      }) || "";
    var counts = { ",": 0, ";": 0, "\t": 0 };
    Object.keys(counts).forEach(function (sep) {
      counts[sep] = firstLine.split(sep).length - 1;
    });
    var delimiter = ",";
    if (counts[";"] > counts[delimiter]) delimiter = ";";
    if (counts["\t"] > counts[delimiter]) delimiter = "\t";

    var rows = [],
      row = [],
      field = "",
      inQuotes = false;
    for (var i = 0; i < src.length; i++) {
      var ch = src[i];
      if (inQuotes) {
        if (ch === '"') {
          if (src[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        row.push(field);
        field = "";
      } else if (ch === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (ch !== "\r") {
        field += ch;
      }
    }
    if (field !== "" || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  // Finds the header row: the first row (among the first 20) with at least two known column names,
  // including Hub Name, Hub Code or State. Returns the row index, or -1.
  function findHeaderRow(grid) {
    var limit = Math.min(grid.length, 20);
    for (var i = 0; i < limit; i++) {
      var keys = (grid[i] || []).map(headerKey);
      var known = keys.filter(Boolean).length;
      if (
        known >= 2 &&
        (keys.indexOf("name") >= 0 ||
          keys.indexOf("code") >= 0 ||
          keys.indexOf("state") >= 0)
      )
        return i;
    }
    return -1;
  }

  // Turns one sheet (array of rows) into hub rows. Each row carries every hub field (blank when absent),
  // plus the sheet name and the row number as it appears in the file.
  function hubRowsFromGrid(grid, sheetName) {
    var headerIndex = findHeaderRow(grid || []);
    if (headerIndex < 0)
      return {
        found: false,
        rows: [],
        headerRow: 0,
        mapped: [],
        ignored: [],
        duplicated: [],
        blank: 0,
      };
    var header = grid[headerIndex] || [];
    var columns = [],
      used = {},
      ignored = [],
      duplicated = [];
    header.forEach(function (cell, c) {
      var text = String(cell === null || cell === undefined ? "" : cell)
        .replace(/\s+/g, " ")
        .trim();
      if (!text) return;
      var key = headerKey(text);
      if (!key) {
        ignored.push(text);
        return;
      }
      if (used[key]) {
        duplicated.push(text);
        return;
      }
      used[key] = true;
      columns.push({ c: c, key: key });
    });
    var rows = [],
      blank = 0;
    for (var r = headerIndex + 1; r < grid.length; r++) {
      var line = grid[r] || [];
      var obj = {};
      FIELD_KEYS.forEach(function (k) {
        obj[k] = "";
      });
      var any = false;
      columns.forEach(function (col) {
        var text = cellText(line[col.c], col.key);
        if (text) {
          obj[col.key] = text;
          any = true;
        }
      });
      if (!any) {
        blank++;
        continue;
      }
      obj.sheet = sheetName || "";
      obj.rowNumber = r + 1;
      rows.push(obj);
    }
    return {
      found: true,
      rows: rows,
      headerRow: headerIndex + 1,
      mapped: Object.keys(used),
      ignored: ignored,
      duplicated: duplicated,
      blank: blank,
    };
  }

  // Reads every sheet of a workbook (or the one CSV sheet). Sheets without a hub header are skipped and named.
  function hubRowsFromSheets(sheets) {
    var rows = [],
      details = [],
      skipped = [];
    (sheets || []).forEach(function (sheet) {
      var result = hubRowsFromGrid(sheet.grid, sheet.name);
      if (!result.found) {
        skipped.push(sheet.name);
        return;
      }
      rows = rows.concat(result.rows);
      details.push({
        sheet: sheet.name,
        headerRow: result.headerRow,
        mapped: result.mapped,
        ignored: result.ignored,
        duplicated: result.duplicated,
        blank: result.blank,
        rows: result.rows.length,
      });
    });
    return { rows: rows, details: details, skippedSheets: skipped };
  }

  var api = {
    FIELD_KEYS: FIELD_KEYS,
    headerKey: headerKey,
    excelSerialToIso: excelSerialToIso,
    cellText: cellText,
    parseCsvGrid: parseCsvGrid,
    findHeaderRow: findHeaderRow,
    hubRowsFromGrid: hubRowsFromGrid,
    hubRowsFromSheets: hubRowsFromSheets,
  };
  root.HubExcel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
