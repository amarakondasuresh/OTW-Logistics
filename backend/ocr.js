// Reads the rider's Partner ID (and name) from a screenshot of the delivery app, e.g. the menu showing
//   "Kandi Nithin"
//   "Partner ID: 28588592"
// Text recognition (Tesseract) runs here on the server; screenshots are not sent to any outside service.
// Text recognition can misread a character now and then, so the portal always asks the user to check
// the filled-in values.
import { createWorker, PSM } from "tesseract.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// English language data shipped with the npm package (no download at run time).
const LANG_PATH = require("@tesseract.js-data/eng").langPath.replace(
  /4\.0\.0$/,
  "4.0.0_best_int",
);
const IDLE_MS = 10 * 60 * 1000; // free the memory when no screenshots arrive for 10 minutes
const TIMEOUT_MS = 20 * 1000;

let workerPromise = null,
  idleTimer = null,
  queue = Promise.resolve();

function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker("eng", 1, {
      langPath: LANG_PATH,
      gzip: true,
      cacheMethod: "none",
      logger: () => {},
      errorHandler: () => {},
    }).catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const w = workerPromise;
    workerPromise = null;
    try {
      (await w)?.terminate();
    } catch {}
  }, IDLE_MS);
  idleTimer.unref?.();
  return workerPromise;
}

const ID_RE =
  /(?:partner|rider)\s*[i1l|]\s*d\s*(?:no\.?|number)?\s*[:;.\-]?\s*([0-9OoIl|]{5,12})/i;
const cleanDigits = (s) => s.replace(/[Oo]/g, "0").replace(/[Il|]/g, "1");

// Finds "Partner ID: 12345678" and the name written on the line above it.
export function parseRiderText(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ID_RE);
    if (!m) continue;
    const partnerId = cleanDigits(m[1]);
    let name = "";
    for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
      const candidate = lines[j]
        .replace(/^[^A-Za-z]+|[^A-Za-z.]+$/g, "")
        .replace(/\s+/g, " ")
        .trim();
      const letters = (candidate.match(/[A-Za-z]/g) || []).length;
      if (
        candidate.length >= 3 &&
        candidate.length <= 40 &&
        letters >= 3 &&
        letters / candidate.length >= 0.75 &&
        /^[A-Za-z][A-Za-z .]*$/.test(candidate)
      ) {
        name = candidate;
        break;
      }
    }
    return { partnerId, name };
  }
  return { partnerId: "", name: "" };
}

async function recognise(buffer, psm) {
  const worker = await getWorker();
  await worker.setParameters({ tessedit_pageseg_mode: psm });
  const { data } = await worker.recognize(buffer);
  return parseRiderText(data.text);
}

// Returns {partnerId, name}; empty strings when nothing could be read. Never throws.
export function readRiderScreenshot(buffer) {
  const job = queue.then(async () => {
    // "Sparse text" reads app screens best; the general mode is a second try.
    let r = await recognise(buffer, PSM.SPARSE_TEXT);
    if (!r.partnerId) r = await recognise(buffer, PSM.AUTO);
    return r;
  });
  queue = job.catch(() => {});
  const timeout = new Promise((resolve) =>
    setTimeout(
      () => resolve({ partnerId: "", name: "", timedOut: true }),
      TIMEOUT_MS,
    ).unref?.(),
  );
  return Promise.race([job, timeout]).catch((err) => {
    console.error("Screenshot reading failed:", err.message);
    return { partnerId: "", name: "" };
  });
}
