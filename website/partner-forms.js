// Shared Franchise / Vendor application submit handler.
// Used by BOTH index.html and services.html so every form sends its data to the
// backend, where the admin panel (dashboard) loads it from.

// Backend address. Same server when the backend serves this site; falls back to
// localhost:8080 when the page is opened as a file or through Live Server.
// To point at a deployed backend, set window.OTW_API_BASE before this script loads.
const OTW_API_BASE =
  window.OTW_API_BASE ||
  (location.protocol === "file:" || ["5500", "5501"].includes(location.port)
    ? "http://localhost:8080"
    : location.origin);

// "Vendor Login" / "Franchise Login" footer links: the portals are served by the backend at /vendor/ and /franchise/.
if (location.protocol === "file:") {
  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("a[data-vendor-link]").forEach((a) => {
      a.href = OTW_API_BASE + "/vendor/";
    });
    document.querySelectorAll("a[data-franchise-link]").forEach((a) => {
      a.href = OTW_API_BASE + "/franchise/";
    });
  });
}

// Applicant Category follows Years of Experience: 0 years = Fresher, 1 to 10 years = Experienced.
// Returns "" when the value is not a whole number from 0 to 10.
function categoryForYears(value) {
  const text = String(value ?? "").trim();
  if (!/^(0|[1-9]|10)$/.test(text)) return "";
  return text === "0" ? "Fresher" : "Experienced";
}

function setShown(element, shown) {
  if (!element) return;
  element.hidden = !shown;
  element.style.display = shown ? "" : "none";
}

const YEARS_EMPTY_MESSAGE = "Please enter Years of Experience";
const YEARS_RANGE_MESSAGE = "Enter a whole number from 0 to 10.";

// Toggle document requirements independently for the Franchise and Vendor forms,
// and keep the Applicant Category in step with Years of Experience.
document.addEventListener("DOMContentLoaded", () => {
  ["ft", "vt"].forEach((prefix) => {
    const form = document.getElementById(prefix === "ft" ? "franchiseForm" : "vendorForm");
    const years = document.getElementById(prefix + "_years");
    const yearsError = document.getElementById(prefix + "_yearsError");
    const category = document.getElementById(prefix + "_applicantCategory");
    const aadhaarWrap = document.getElementById(prefix + "_aadhaarWrap");
    const aadhaar = document.getElementById(prefix + "_aadhaar");
    const monthsWrap = document.getElementById(prefix + "_salaryMonthsWrap");
    const months = document.getElementById(prefix + "_salaryMonths");
    const slipsWrap = document.getElementById(prefix + "_salarySlipsWrap");
    const slips = document.getElementById(prefix + "_salarySlips");
    if (!form || !category || !years) return;
    const update = () => {
      const selected = ["Fresher", "Experienced"].includes(category.value);
      const experienced = category.value === "Experienced";
      // .form-group sets display:flex, which overrides the hidden attribute, so the display is set directly.
      setShown(aadhaarWrap, selected); aadhaar.required = selected;
      setShown(monthsWrap, experienced); setShown(slipsWrap, experienced);
      months.required = experienced; slips.required = experienced;
      // Salary slips only apply to Experienced applicants; clear them when the category is Fresher.
      if (!experienced) { months.value = ""; slips.value = ""; }
      const count = Number(months.value || 0);
      slips.setAttribute("data-required-count", count ? String(count) : "0");
      slips.title = count ? `Select exactly ${count} salary slip files` : "Select 3 or 6 salary slips";
    };

    // Years of Experience: only whole numbers 0 to 10. Anything else is rejected and the last valid value is kept.
    let lastValidYears = "";
    const syncYears = (showEmptyMessage) => {
      const text = years.value.trim();
      let shown = "";
      if (text === "") {
        lastValidYears = "";
        shown = showEmptyMessage ? YEARS_EMPTY_MESSAGE : "";
      } else if (/^\d+$/.test(text) && Number(text) <= 10) {
        lastValidYears = String(Number(text));
        if (years.value !== lastValidYears) years.value = lastValidYears;
      } else {
        years.value = lastValidYears;
        shown = YEARS_RANGE_MESSAGE;
      }
      category.value = categoryForYears(lastValidYears);
      years.setCustomValidity(lastValidYears === "" ? YEARS_EMPTY_MESSAGE : "");
      if (yearsError) {
        yearsError.textContent = shown;
        yearsError.hidden = !shown;
      }
      update();
    };
    years.addEventListener("input", () => syncYears(true));
    years.addEventListener("blur", () => syncYears(true));
    years.addEventListener("invalid", () => syncYears(true));
    years.addEventListener("keydown", (event) => {
      if (["e", "E", "+", "-", ".", ","].includes(event.key)) event.preventDefault();
    });

    category.addEventListener("change", update); months.addEventListener("change", update);
    form.addEventListener("submit", (event) => {
      if (category.value === "Experienced" && slips.files.length !== Number(months.value)) {
        event.preventDefault(); event.stopImmediatePropagation();
        alert(`Please upload exactly ${months.value || "3 or 6"} salary slip files.`);
      }
    }, true);
    syncYears(false);
  });
});

function applicationSubmissionKey(form) {
  if (!form.dataset.submissionKey) {
    const random =
      window.crypto && typeof window.crypto.randomUUID === "function"
        ? window.crypto.randomUUID()
        : Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    form.dataset.submissionKey = random.replace(/[^A-Za-z0-9-]/g, "").slice(0, 80);
  }
  return form.dataset.submissionKey;
}

async function handlePortalSubmit(e, portalType) {
  e.preventDefault();
  const form = e.target;
  if (form.dataset.submitting === "true") return;
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  const submitButton = form.querySelector(
    'button[type="submit"], input[type="submit"]',
  );
  const originalHtml = submitButton ? submitButton.innerHTML : "";
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "Submitting…";
  }
  form.dataset.submitting = "true";

  const formData = new FormData(form);
  // One key per form: a repeated click or a resend after a dropped connection returns the same application
  // instead of creating a second one (the server checks it before saving anything).
  formData.set("submissionKey", applicationSubmissionKey(form));
  const data = Object.fromEntries([...formData.entries()].filter(([key, value]) => !(value instanceof File)));
  // The area dropdown's value is "Post office|PIN"; keep only the area name (PIN has its own field).
  if (typeof data.location === "string")
    data.location = data.location.split("|")[0].trim();
  const storageKey =
    portalType === "Franchise"
      ? "otw_franchise_applications"
      : "otw_vendor_applications";
  try {
    // 1. Send to the backend so it appears in the admin panel
    //    (Client > Franchise / Vendor and Partner Applications).
    formData.set("type", portalType);
    formData.set("portalType", portalType);
    const res = await fetch(OTW_API_BASE + "/api/partner-applications", {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      // 400 = a required field or format is wrong; show the server's message so the visitor knows what to fix.
      let message = "";
      try {
        message = (await res.json()).error || "";
      } catch (_) {}
      const err = new Error(message || "Server responded " + res.status);
      err.userMessage = res.status === 400 ? message : "";
      throw err;
    }
    const out = await res.json();
    const saved = out.application || {};
    const applicationId = saved.appId;
    if (!applicationId) throw new Error("No application ID returned");

    // 2. Keep a copy in this browser so the applicant can see the confirmation page.
    const application = {
      ...data,
      portalType,
      applicationId,
      submittedAt: saved.submittedAt || new Date().toISOString(),
      confirmationEmail: !!out.confirmationEmail,
    };
    let existing = [];
    try {
      existing = JSON.parse(localStorage.getItem(storageKey) || "[]");
    } catch (_) {}
    if (!Array.isArray(existing)) existing = [];
    existing.push(application);
    try {
      localStorage.setItem(storageKey, JSON.stringify(existing));
      localStorage.setItem("otw_last_application_id", applicationId);
    } catch (_) {}
    window.location.href =
      "application-details.html?id=" + encodeURIComponent(applicationId);
  } catch (err) {
    console.error("Application submit failed:", err);
    form.dataset.submitting = "false";
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.innerHTML = originalHtml || "Submit Application";
    }
    let notification = document.getElementById("statusNotification");
    if (!notification) {
      notification = document.createElement("div");
      notification.id = "statusNotification";
      form.prepend(notification);
    }
    notification.setAttribute("role", "alert");
    notification.textContent = err.userMessage
      ? err.userMessage + " Your entered information is still on this page."
      : "We could not submit your application right now. Your entered information is still on this page. Please check your connection and try again.";
    notification.style.cssText =
      "display:block;padding:12px 16px;margin-bottom:16px;background:#fff1f0;color:#9b1c1c;border:1px solid #f5b7b1;border-radius:8px;";
    notification.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}
