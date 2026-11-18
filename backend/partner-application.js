// Franchise / Vendor application rules.
// Pure functions only (no database, no network) so they can be tested on their own.
// server.js uses these for POST /api/partner-applications.

// Fields that must never be collected or stored for vendors. They were removed from the
// Vendor Registration Form; anything posted with these names is dropped.
export const REMOVED_FIELDS = Object.freeze([
  "gstNumber",
  "panNumber",
  "serviceType",
]);

// Fields an application may contain. Anything else is ignored.
// The first group is what the website forms send; the rest is what the admin \"New application\"
// form sends, which stays as it was.
export const APPLICATION_FIELDS = Object.freeze([
  // Website: Franchise Territory Application Form
  "dateOfBirth",
  "whatsappNumber",
  "locationArea",
  "pincode",
  "yearsOfExperience",
  "applicantCategory",
  "salarySlipMonths",
  // Website: Franchise + Vendor forms
  "type",
  "portalType",
  "fullName",
  "companyName",
  "ownerName",
  "contactNumber",
  "gmail",
  "state",
  "district",
  "cityOrVillage",
  "address",
  "fullAddress",
  "investmentCapacity",
  "preferredLocation",
  "experience",
  "additionalMessage",
  "additionalInfo",
  // Admin \"New application\" form (unchanged)
  "name",
  "contact",
  "contactName",
  "mobile",
  "whatsapp",
  "email",
  "city",
  "location",
  "locality",
  "street",
  "nearby",
  "landmark",
  "education",
  "educationalQualification",
  "remarks",
  "businessName",
  "businessType",
  "status",
]);

const LONG_FIELDS = new Set([
  "experience",
  "remarks",
  "additionalMessage",
  "additionalInfo",
]);

// Required on public website submissions (admin entries use the looser rules).
// The Franchise Territory and Vendor Registration forms ask the same questions.
const TERRITORY_REQUIRED = Object.freeze([
  "fullName",
  "dateOfBirth",
  "gmail",
  "contactNumber",
  "whatsappNumber",
  "state",
  "district",
  "cityOrVillage",
  "locationArea",
  "pincode",
  "address",
  "yearsOfExperience",
]);
export const REQUIRED = Object.freeze({
  Franchise: TERRITORY_REQUIRED,
  Vendor: TERRITORY_REQUIRED,
});

export const LABELS = Object.freeze({
  fullName: "Full Name",
  dateOfBirth: "Date of Birth",
  gmail: "Email Address",
  contactNumber: "Mobile Number",
  whatsappNumber: "WhatsApp Number",
  state: "State",
  district: "District",
  cityOrVillage: "Village / City Name",
  locationArea: "Location / Area Name",
  pincode: "PIN Code",
  address: "Full Address",
  yearsOfExperience: "Years of Experience",
  fullAddress: "Complete Business Address",
  companyName: "Company / Business Name",
  ownerName: "Owner Name",
  additionalInfo: "Additional Information",
});

export function typeOf(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase() === "vendor"
    ? "Vendor"
    : "Franchise";
}

// Keeps only allowed fields, removes surrounding spaces and caps the length.
export function cleanInput(raw) {
  const input = {};
  if (!raw || typeof raw !== "object") return input;
  for (const key of APPLICATION_FIELDS) {
    const value = raw[key];
    if (value === undefined || value === null || typeof value === "object")
      continue;
    const cap =
      LONG_FIELDS.has(key) || key.toLowerCase().includes("address")
        ? 2000
        : 200;
    input[key] = String(value).trim().slice(0, cap);
  }
  return input;
}

// \"+91 98765 43210\", \"98765-43210\" and \"9876543210\" all become 9876543210.
// Returns '' when the number is not a valid Indian mobile (10 digits, starting 6-9).
export function normalizeMobile(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : "";
}

export function isValidEmail(value) {
  return /^[^\s@<>()\",;:]+@[^\s@<>()\",;:]+\.[^\s@<>()\",;:]{2,}$/.test(
    String(value ?? "").trim(),
  );
}

// Indian PIN code: exactly six digits, first digit 1-9.
export function isValidPin(value) {
  return /^[1-9]\d{5}$/.test(String(value ?? "").trim());
}

// Date of birth as YYYY-MM-DD (from the date picker): a real calendar date, not in the future.
export function isValidDateOfBirth(value, today = new Date()) {
  const text = String(value ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d
  )
    return false;
  return (
    date.getTime() <=
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  );
}

// Whole years of experience: 0 to 10.
export function isValidYears(value) {
  return /^(0|[1-9]|10)$/.test(String(value ?? "").trim());
}

// Applicant Category follows Years of Experience: 0 years is Fresher, 1 to 10 is Experienced.
// Returns "" when the years value is not valid.
export function categoryForYears(value) {
  const text = String(value ?? "").trim();
  if (!isValidYears(text)) return "";
  return text === "0" ? "Fresher" : "Experienced";
}

// Checks a public website submission. Returns a list of messages (empty when valid).
export function validatePublicApplication(input, type) {
  const errors = [];
  for (const key of REQUIRED[type]) {
    if (!String(input[key] ?? "").trim())
      errors.push(`${LABELS[key] || key} is required.`);
  }
  if (input.contactNumber && !normalizeMobile(input.contactNumber)) {
    errors.push(
      "Mobile Number must be a 10-digit Indian mobile number starting with 6-9.",
    );
  }
  if (input.whatsappNumber && !normalizeMobile(input.whatsappNumber)) {
    errors.push(
      "WhatsApp Number must be a 10-digit Indian mobile number starting with 6-9.",
    );
  }
  if (input.gmail && !isValidEmail(input.gmail)) {
    errors.push("Email Address is not valid.");
  }
  if (input.pincode && !isValidPin(input.pincode)) {
    errors.push("PIN Code must be a 6-digit number.");
  }
  if (input.dateOfBirth && !isValidDateOfBirth(input.dateOfBirth)) {
    errors.push("Date of Birth is not a valid past date.");
  }
  if (input.applicantCategory && !["Fresher", "Experienced"].includes(input.applicantCategory)) errors.push("Select Fresher or Experienced.");
  if (input.applicantCategory === "Experienced" && !["3", "6"].includes(String(input.salarySlipMonths || ""))) errors.push("Experienced applicants must select 3-month or 6-month salary slips.");
  if (input.yearsOfExperience && !isValidYears(input.yearsOfExperience)) {
    errors.push("Years of Experience must be a whole number from 0 to 10.");
  }
  const derived = categoryForYears(input.yearsOfExperience);
  if (derived && input.applicantCategory && input.applicantCategory !== derived) {
    errors.push("Applicant Category must match Years of Experience.");
  }
  return errors;
}

// Converts the form answers into the fields the admin dashboard and the portal login use.
// The original answers are kept as well, so the detail view shows what the applicant typed.
export function recordFields(input, type) {
  const isVendor = type === "Vendor";
  const mobile =
    normalizeMobile(input.contactNumber) ||
    String(input.contactNumber || input.mobile || "");
  const whatsapp =
    normalizeMobile(input.whatsappNumber) ||
    String(input.whatsappNumber || input.whatsapp || "");
  const address = input.address || input.fullAddress || "";
  return {
    name: String(
      isVendor
        ? input.fullName ||
            input.companyName ||
            input.ownerName ||
            input.name ||
            ""
        : input.fullName || input.name || input.companyName || "",
    ),
    contact: String(
      input.contactName ||
        input.fullName ||
        input.ownerName ||
        input.name ||
        "",
    ),
    mobile,
    whatsapp,
    email: String(input.gmail || input.email || ""),
    state: String(input.state || "Andhra Pradesh"),
    district: String(input.district || ""),
    city: String(input.cityOrVillage || input.city || ""),
    pincode: String(input.pincode || ""),
    yearsOfExperience: String(input.yearsOfExperience || ""),
    address,
    street: String(input.street || address),
    locality: String(
      input.locationArea || input.locality || input.location || "",
    )
      .split("|")[0]
      .trim(),
    education: String(input.education || input.educationalQualification || ""),
    remarks: String(
      input.remarks ||
        input.additionalMessage ||
        input.additionalInfo ||
        input.experience ||
        "",
    ),
  };
}
