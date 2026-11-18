// Google Drive sync for the Payment Management Excel files (Admin Portal only).
//
// An admin connects one Google account (OAuth, read-only Drive scope) and chooses the folder that holds the payment
// Excel files. A sync lists the .xlsx / .xls files in that folder, downloads each file whose content changed, reads it
// with the same Excel reader as a manual upload (dashboard/payment-excel.js) and saves it with the same rules
// (weekly-payments.js). Manual upload and Drive sync therefore share one import path and one database.
//
// Safety rules:
//   - A file is written only after it has been read and validated in full. A broken file is recorded as failed with
//     the reason, and the saved payment data is left as it was.
//   - The Google refresh token is stored encrypted (AES-256-GCM, key derived from DRIVE_TOKEN_SECRET). Access tokens
//     are kept in memory only. Neither is ever returned to the browser.
//   - Only an admin can connect, choose the folder, sync or disconnect (routes are guarded in drive-sync-routes.js).
//
// Google's REST API is called with plain fetch, so no Google client library is needed.
// Google-native Sheets files are not read; the payment sheet must be an uploaded .xlsx or .xls file.
import crypto from "node:crypto";

export class DriveSyncError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const DRIVE = "https://www.googleapis.com/drive/v3";
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const EXCEL_MIME = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
];
const FOLDER_MIME = "application/vnd.google-apps.folder";
const STATE_TTL_MS = 10 * 60 * 1000;
const FOLDER_ID = /^[A-Za-z0-9_-]{10,100}$/;

export function createDriveSyncService({
  db,
  weeklyPayments,
  audit = () => {},
  parseWorkbook,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
  env = process.env,
}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS drive_settings(
      id INTEGER PRIMARY KEY CHECK(id = 1),
      refresh_token_enc TEXT NOT NULL DEFAULT '',
      connected_email TEXT NOT NULL DEFAULT '',
      connected_by TEXT NOT NULL DEFAULT '',
      connected_at TEXT NOT NULL DEFAULT '',
      folder_id TEXT NOT NULL DEFAULT '',
      folder_name TEXT NOT NULL DEFAULT '',
      last_sync_at TEXT NOT NULL DEFAULT '',
      last_status TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS drive_files(
      file_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      modified_time TEXT NOT NULL DEFAULT '',
      md5 TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      synced_at TEXT NOT NULL DEFAULT '',
      total INTEGER NOT NULL DEFAULT 0, inserted INTEGER NOT NULL DEFAULT 0,
      updated INTEGER NOT NULL DEFAULT 0, unchanged INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS drive_oauth_states(
      state TEXT PRIMARY KEY, admin_email TEXT NOT NULL, created_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO drive_settings(id) VALUES(1);`);

  const settings = () =>
    db.prepare("SELECT * FROM drive_settings WHERE id = 1").get();
  let cache = { token: "", exp: 0 };
  let running = null;

  // ---------- configuration and encryption ----------
  function config() {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      throw new DriveSyncError(
        503,
        "Google Drive is not set up yet. The site owner must add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to backend/.env.",
      );
    }
    if (!env.DRIVE_TOKEN_SECRET || env.DRIVE_TOKEN_SECRET.length < 16) {
      throw new DriveSyncError(
        503,
        "Google Drive is not set up yet. The site owner must add DRIVE_TOKEN_SECRET (at least 16 characters) to backend/.env.",
      );
    }
    return { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET };
  }
  const cipherKey = () =>
    crypto
      .createHash("sha256")
      .update(env.DRIVE_TOKEN_SECRET || "")
      .digest();
  function seal(text) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", cipherKey(), iv);
    const enc = Buffer.concat([c.update(text, "utf8"), c.final()]);
    return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
  }
  function open(sealed) {
    const [iv, tag, enc] = sealed
      .split(".")
      .map((s) => Buffer.from(s, "base64"));
    const d = crypto.createDecipheriv("aes-256-gcm", cipherKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
  }
  const redirectUri = (baseUrl) =>
    env.GOOGLE_REDIRECT_URI ||
    `${String(baseUrl).replace(/\/+$/, "")}/api/admin/drive/callback`;

  // ---------- OAuth ----------
  async function postToken(params) {
    const r = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token)
      throw new DriveSyncError(
        401,
        "Google did not accept the sign-in. Please click Connect Google Drive again.",
      );
    return j;
  }

  // The link the admin's browser is sent to. The state is random, one-time and tied to the admin who asked for it.
  function connectUrl({ adminEmail, baseUrl }) {
    const c = config();
    const state = crypto.randomBytes(24).toString("base64url");
    const t = now();
    db.prepare("DELETE FROM drive_oauth_states WHERE created_at < ?").run(
      new Date(Date.parse(t) - STATE_TTL_MS).toISOString(),
    );
    db.prepare(
      "INSERT INTO drive_oauth_states(state, admin_email, created_at) VALUES(?,?,?)",
    ).run(state, adminEmail, t);
    const q = new URLSearchParams({
      client_id: c.id,
      redirect_uri: redirectUri(baseUrl),
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return `${AUTH_URL}?${q}`;
  }

  async function completeConnect({ code, state, adminEmail, baseUrl }) {
    const c = config();
    const st = String(state || "");
    const row = st
      ? db.prepare("SELECT * FROM drive_oauth_states WHERE state = ?").get(st)
      : null;
    if (st)
      db.prepare("DELETE FROM drive_oauth_states WHERE state = ?").run(st); // one use only
    const fresh =
      row && Date.parse(now()) - Date.parse(row.created_at) <= STATE_TTL_MS;
    if (!row || !fresh || row.admin_email !== adminEmail) {
      throw new DriveSyncError(
        400,
        "The Google sign-in link has expired or does not belong to this session. Please click Connect Google Drive again.",
      );
    }
    if (!code)
      throw new DriveSyncError(
        400,
        "Google did not return a sign-in code. Please try again.",
      );
    const tok = await postToken({
      grant_type: "authorization_code",
      code: String(code),
      client_id: c.id,
      client_secret: c.secret,
      redirect_uri: redirectUri(baseUrl),
    });
    if (!tok.refresh_token) {
      throw new DriveSyncError(
        400,
        "Google did not give a long-term access token. Remove this app from the Google account's third-party access, then connect again.",
      );
    }
    const email = await accountEmail(tok.access_token).catch(() => "");
    db.prepare(
      "UPDATE drive_settings SET refresh_token_enc = ?, connected_email = ?, connected_by = ?, connected_at = ? WHERE id = 1",
    ).run(seal(tok.refresh_token), email, adminEmail, now());
    cache = {
      token: tok.access_token,
      exp: Date.now() + (tok.expires_in || 3600) * 1000,
    };
    audit(adminEmail, "drive_connected", { account: email });
    return { account: email };
  }

  async function accessToken() {
    if (cache.token && cache.exp > Date.now() + 60000) return cache.token;
    const s = settings();
    if (!s.refresh_token_enc)
      throw new DriveSyncError(409, "Google Drive is not connected.");
    const c = config();
    let tok;
    try {
      tok = await postToken({
        grant_type: "refresh_token",
        refresh_token: open(s.refresh_token_enc),
        client_id: c.id,
        client_secret: c.secret,
      });
    } catch (err) {
      throw new DriveSyncError(
        401,
        "Google Drive access was revoked or has expired. Please click Connect Google Drive again.",
      );
    }
    cache = {
      token: tok.access_token,
      exp: Date.now() + (tok.expires_in || 3600) * 1000,
    };
    return cache.token;
  }

  async function driveGet(url, token) {
    const r = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (r.status === 401) {
      cache = { token: "", exp: 0 };
      throw new DriveSyncError(
        401,
        "Google Drive access was revoked. Please click Connect Google Drive again.",
      );
    }
    if (!r.ok)
      throw new DriveSyncError(
        502,
        `Google Drive returned an error (${r.status}). Please try again later.`,
      );
    return r;
  }
  async function accountEmail(token) {
    const r = await driveGet(`${DRIVE}/about?fields=user/emailAddress`, token);
    return String((await r.json())?.user?.emailAddress || "");
  }

  // ---------- folder ----------
  async function listFolders() {
    const token = await accessToken();
    const u = new URL(`${DRIVE}/files`);
    u.search = new URLSearchParams({
      q: `mimeType='${FOLDER_MIME}' and trashed=false`,
      fields: "files(id,name)",
      pageSize: "200",
      orderBy: "name",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    }).toString();
    const r = await driveGet(u, token);
    return ((await r.json()).files || []).map((f) => ({
      id: f.id,
      name: f.name,
    }));
  }

  async function chooseFolder({ folderId, actor }) {
    const id = String(folderId || "").trim();
    if (!FOLDER_ID.test(id))
      throw new DriveSyncError(400, "Choose a folder from the list.");
    const token = await accessToken();
    const r = await driveGet(
      `${DRIVE}/files/${encodeURIComponent(id)}?fields=id,name,mimeType&supportsAllDrives=true`,
      token,
    );
    const f = await r.json();
    if (f.mimeType !== FOLDER_MIME)
      throw new DriveSyncError(400, "That item is not a folder.");
    db.prepare(
      "UPDATE drive_settings SET folder_id = ?, folder_name = ? WHERE id = 1",
    ).run(id, String(f.name || "").slice(0, 200));
    audit(actor, "drive_folder_selected", { folder: f.name });
    return { id, name: f.name };
  }

  // ---------- sync ----------
  async function listExcelFiles(folderId, token) {
    const q = `'${folderId}' in parents and trashed=false and (${EXCEL_MIME.map((m) => `mimeType='${m}'`).join(" or ")})`;
    const out = [];
    let pageToken = "";
    do {
      const u = new URL(`${DRIVE}/files`);
      u.search = new URLSearchParams({
        q,
        fields: "nextPageToken,files(id,name,modifiedTime,md5Checksum)",
        pageSize: "200",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        ...(pageToken ? { pageToken } : {}),
      }).toString();
      const j = await (await driveGet(u, token)).json();
      out.push(...(j.files || []));
      pageToken = j.nextPageToken || "";
    } while (pageToken && out.length < 1000);
    return out;
  }

  function recordFile(f, status, error, c = {}) {
    db.prepare(
      `INSERT INTO drive_files(file_id,name,modified_time,md5,status,error,synced_at,total,inserted,updated,unchanged)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(file_id) DO UPDATE SET name=excluded.name, modified_time=excluded.modified_time, md5=excluded.md5,
        status=excluded.status, error=excluded.error, synced_at=excluded.synced_at, total=excluded.total,
        inserted=excluded.inserted, updated=excluded.updated, unchanged=excluded.unchanged`,
    ).run(
      f.id,
      String(f.name || "").slice(0, 200),
      f.modifiedTime || "",
      f.md5Checksum || "",
      status,
      String(error || "").slice(0, 500),
      now(),
      c.total || 0,
      c.inserted || 0,
      c.updated || 0,
      c.unchanged || 0,
    );
    return { fileId: f.id, name: f.name, status, error: error || "", ...c };
  }

  async function syncFile(f, token, actor) {
    const prev = db
      .prepare("SELECT * FROM drive_files WHERE file_id = ?")
      .get(f.id);
    const modified = f.modifiedTime || "",
      md5 = f.md5Checksum || "";
    if (
      prev &&
      prev.status === "synced" &&
      prev.modified_time === modified &&
      prev.md5 === md5 &&
      prev.name === f.name
    ) {
      return {
        fileId: f.id,
        name: f.name,
        status: "unchanged",
        error: "",
        total: prev.total,
        inserted: 0,
        updated: 0,
        unchanged: prev.total,
      };
    }
    let buf;
    try {
      const r = await driveGet(
        `${DRIVE}/files/${encodeURIComponent(f.id)}?alt=media&supportsAllDrives=true`,
        token,
      );
      buf = Buffer.from(await r.arrayBuffer());
    } catch (err) {
      return recordFile(
        f,
        "failed",
        err.message || "The file could not be downloaded.",
      );
    }
    const fileHash = crypto.createHash("sha256").update(buf).digest("hex");
    let parsed;
    try {
      parsed = parseWorkbook(buf);
    } catch {
      parsed = {
        ok: false,
        error: "The file could not be read as an Excel file.",
      };
    }
    if (!parsed || !parsed.ok)
      return recordFile(
        f,
        "failed",
        parsed?.error || "No payment table could be read from this file.",
      );
    try {
      const result = weeklyPayments.importRecords(
        { fileName: f.name, fileHash, records: parsed.records },
        actor,
      );
      return recordFile(f, "synced", "", {
        total: result.total,
        inserted: result.inserted,
        updated: result.updated,
        unchanged: result.unchanged,
      });
    } catch (err) {
      return recordFile(
        f,
        "failed",
        err.message ||
          "The rows could not be saved. The previous payment data is unchanged.",
      );
    }
  }

  async function runSync(trigger, actor) {
    const s = settings();
    if (!s.refresh_token_enc)
      throw new DriveSyncError(409, "Google Drive is not connected.");
    if (!s.folder_id)
      throw new DriveSyncError(409, "Choose the payment folder first.");
    db.prepare(
      "UPDATE drive_settings SET last_status = 'pending', last_error = '' WHERE id = 1",
    ).run();
    try {
      const token = await accessToken();
      const files = (await listExcelFiles(s.folder_id, token)).sort((a, b) =>
        String(a.modifiedTime || "").localeCompare(
          String(b.modifiedTime || ""),
        ),
      );
      const results = [];
      if (!files.length) {
        const msg =
          "No Excel (.xlsx or .xls) payment files were found in the folder.";
        db.prepare(
          "UPDATE drive_settings SET last_sync_at = ?, last_status = 'failed', last_error = ? WHERE id = 1",
        ).run(now(), msg);
        audit(actor, "drive_sync", { trigger, files: 0, error: msg });
        return {
          status: "failed",
          error: msg,
          files: [],
          synced: 0,
          failed: 0,
          unchanged: 0,
        };
      }
      for (const f of files)
        results.push(await syncFile(f, token, actor || "Google Drive sync"));
      const failed = results.filter((r) => r.status === "failed");
      const status = failed.length ? "failed" : "synced";
      const error = failed
        .map((r) => `${r.name}: ${r.error}`)
        .join(" ")
        .slice(0, 1000);
      db.prepare(
        "UPDATE drive_settings SET last_sync_at = ?, last_status = ?, last_error = ? WHERE id = 1",
      ).run(now(), status, error);
      const totals = {
        inserted: results.reduce((n, r) => n + (r.inserted || 0), 0),
        updated: results.reduce((n, r) => n + (r.updated || 0), 0),
        unchanged: results.reduce((n, r) => n + (r.unchanged || 0), 0),
      };
      audit(actor || "Google Drive sync", "drive_sync", {
        trigger,
        files: results.length,
        failed: failed.length,
        ...totals,
      });
      return {
        status,
        error,
        files: results,
        synced: results.filter((r) => r.status === "synced").length,
        failed: failed.length,
        unchanged: results.filter((r) => r.status === "unchanged").length,
        ...totals,
      };
    } catch (err) {
      const msg =
        err instanceof DriveSyncError
          ? err.message
          : "Google Drive sync failed. Please try again.";
      db.prepare(
        "UPDATE drive_settings SET last_sync_at = ?, last_status = 'failed', last_error = ? WHERE id = 1",
      ).run(now(), msg.slice(0, 1000));
      if (!(err instanceof DriveSyncError))
        console.error("Drive sync failed:", err && err.message);
      throw err instanceof DriveSyncError ? err : new DriveSyncError(502, msg);
    }
  }

  // One sync at a time: a second request while one is running gets the same result instead of a parallel run.
  function sync({ trigger = "manual", actor = "" } = {}) {
    if (!running)
      running = runSync(trigger, actor).finally(() => {
        running = null;
      });
    return running;
  }

  function schedule(minutes) {
    const ms = Math.max(5, Number(minutes) || 15) * 60000;
    const timer = setInterval(() => {
      const s = settings();
      if (!s.refresh_token_enc || !s.folder_id) return;
      sync({ trigger: "scheduled" }).catch((err) =>
        console.error("Scheduled Drive sync:", err.message),
      );
    }, ms);
    timer.unref?.();
    return timer;
  }

  async function disconnect({ actor }) {
    const s = settings();
    if (s.refresh_token_enc) {
      try {
        const rt = open(s.refresh_token_enc);
        await fetchImpl(REVOKE_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: rt }),
        });
      } catch {
        /* revoking is best effort; the token is removed below either way */
      }
    }
    db.prepare(
      "UPDATE drive_settings SET refresh_token_enc = '', connected_email = '', connected_by = '', connected_at = '', folder_id = '', folder_name = '', last_status = '', last_error = '' WHERE id = 1",
    ).run();
    cache = { token: "", exp: 0 };
    audit(actor, "drive_disconnected", {});
    return { ok: true };
  }

  // What the Admin Portal shows. Never includes a token.
  function status() {
    const s = settings();
    const files = db
      .prepare(
        "SELECT file_id, name, modified_time, status, error, synced_at, total, inserted, updated, unchanged FROM drive_files ORDER BY name",
      )
      .all()
      .map((f) => ({
        fileId: f.file_id,
        name: f.name,
        modifiedTime: f.modified_time,
        status: f.status,
        error: f.error,
        syncedAt: f.synced_at,
        total: f.total,
        inserted: f.inserted,
        updated: f.updated,
        unchanged: f.unchanged,
      }));
    return {
      configured: !!(
        env.GOOGLE_CLIENT_ID &&
        env.GOOGLE_CLIENT_SECRET &&
        env.DRIVE_TOKEN_SECRET &&
        env.DRIVE_TOKEN_SECRET.length >= 16
      ),
      connected: !!s.refresh_token_enc,
      account: s.connected_email,
      folder: s.folder_id ? { id: s.folder_id, name: s.folder_name } : null,
      lastSyncAt: s.last_sync_at,
      lastStatus: s.last_status,
      lastError: s.last_error,
      files,
    };
  }

  return {
    connectUrl,
    completeConnect,
    listFolders,
    chooseFolder,
    sync,
    schedule,
    disconnect,
    status,
  };
}
