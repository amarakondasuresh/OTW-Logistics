// Territory application forms (Franchise and Vendor): searchable State / District / Village / Area fields,
// PIN suggestion, and date/years checks. Used by index.html and services.html.
// Needs india-districts.js (window.OTW_INDIA) loaded first.
//
// Village / city and area suggestions and the PIN come from the public India Post PIN directory
// (api.postalpincode.in). If that service cannot be reached, the fields still work: the visitor
// types the names by hand and a short note says the suggestions are unavailable.
(function () {
  const data = window.OTW_INDIA;
  if (!data) return;
  // Each form uses its own ID prefix: ft_ for Franchise, vt_ for Vendor.
  [
    ["franchiseForm", "ft"],
    ["vendorForm", "vt"],
  ].forEach(([formId, prefix]) => {
    const form = document.getElementById(formId);
    if (form) initTerritoryForm(form, prefix);
  });

  function initTerritoryForm(form, p) {
    const $ = (id) => document.getElementById(id);
    const stateInput = $(p + "_state"),
      districtInput = $(p + "_district"),
      cityInput = $(p + "_city");
    const areaInput = $(p + "_area"),
      pinInput = $(p + "_pin"),
      dobInput = $(p + "_dob");
    const stateNames = Object.keys(data.states);
    const POSTAL_API = "https://api.postalpincode.in/postoffice/";
    const POSTAL_TIMEOUT_MS = 8000;

    // ---------- helpers ----------
    const norm = (s) =>
      String(s || "")
        .toLowerCase()
        .replace(/&/g, "and")
        .replace(/[^a-z0-9]/g, "");
    const matchFrom = (value, list) => {
      const target = norm(value);
      if (!target) return "";
      return list.find((item) => norm(item) === target) || "";
    };
    const fillList = (datalist, values) => {
      datalist.textContent = "";
      [...new Set(values.filter(Boolean))].forEach((v) => {
        const option = document.createElement("option");
        option.value = v;
        datalist.appendChild(option);
      });
    };
    const setHint = (input, id, text) => {
      let hint = $(id);
      if (!hint) {
        hint = document.createElement("small");
        hint.id = id;
        hint.style.cssText =
          "display:block;margin-top:4px;font-size:.8rem;color:var(--muted,#6b7280);";
        input.parentElement.appendChild(hint);
      }
      hint.textContent = text || "";
    };
    const todayISO = () => {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    // Removes the India Post suffix from office names, e.g. "Hindupur B.O" -> "Hindupur".
    const cleanOfficeName = (name) =>
      String(name || "")
        .replace(/\s+(B\.?O\.?|S\.?O\.?|H\.?O\.?|SO|BO|HO|PO)$/i, "")
        .trim();

    // ---------- State ----------
    fillList($(p + "_state_list"), stateNames);
    dobInput.max = todayISO();

    function currentState() {
      return matchFrom(stateInput.value, stateNames);
    }
    function currentDistrict() {
      const st = currentState();
      return st ? matchFrom(districtInput.value, data.states[st]) : "";
    }
    function validateState() {
      const v = stateInput.value.trim();
      stateInput.setCustomValidity(
        v && !currentState()
          ? "Please choose a state or union territory from the list."
          : "",
      );
    }
    function validateDistrict() {
      const st = currentState();
      const v = districtInput.value.trim();
      if (!st) {
        districtInput.setCustomValidity(
          v ? "Choose a state first, then a district." : "",
        );
      } else {
        districtInput.setCustomValidity(
          v && !currentDistrict()
            ? "Please choose a district from the list for the selected state."
            : "",
        );
      }
    }

    let lastState = "";
    let lastDistrict = "";
    stateInput.addEventListener("input", () => {
      const st = currentState();
      if (st) stateInput.value = st;
      validateState();
      if ((st || "") !== lastState) {
        lastState = st || "";
        districtInput.value = "";
        resetAfterDistrict();
      }
      fillList($(p + "_district_list"), st ? data.states[st] : []);
      validateDistrict();
    });
    stateInput.addEventListener("change", () => {
      stateInput.value = currentState() || stateInput.value;
      validateState();
    });

    // ---------- District ----------
    districtInput.addEventListener("input", () => {
      const d = currentDistrict();
      if (d) districtInput.value = d;
      validateDistrict();
      if ((d || "") !== lastDistrict) {
        lastDistrict = d || "";
        resetAfterDistrict();
      }
    });
    districtInput.addEventListener("change", () => {
      districtInput.value = currentDistrict() || districtInput.value;
      validateDistrict();
    });

    // ---------- Village / city and area (India Post directory) ----------
    let offices = [];
    let activeRequest = null;
    const cache = new Map();

    function resetAfterDistrict() {
      cityInput.value = "";
      areaInput.value = "";
      clearAutoPin();
      offices = [];
      fillList($(p + "_city_list"), []);
      fillList($(p + "_area_list"), []);
      setHint(cityInput, p + "_city_hint", "");
      setHint(areaInput, p + "_area_hint", "");
    }

    // Keeps the offices in the chosen state and district. If the directory spells the district
    // differently, falls back to the state alone so suggestions still appear.
    function filterOffices(list) {
      const st = currentState(),
        dist = currentDistrict();
      const byState = list.filter((o) => norm(o.State) === norm(st));
      const byDistrict = byState.filter((o) => norm(o.District) === norm(dist));
      if (byDistrict.length) return byDistrict;
      if (byState.length) return byState;
      return list.filter((o) => norm(o.District) === norm(dist)); // state spelled differently in the directory
    }

    async function lookupOffices(text) {
      const key = norm(text);
      if (key.length < 3) return null;
      if (cache.has(key)) return cache.get(key);
      if (activeRequest) activeRequest.abort();
      const controller = new AbortController();
      activeRequest = controller;
      const timer = setTimeout(() => controller.abort(), POSTAL_TIMEOUT_MS);
      try {
        const res = await fetch(POSTAL_API + encodeURIComponent(text.trim()), {
          signal: controller.signal,
        });
        const body = await res.json();
        const list =
          body && body[0] && body[0].Status === "Success"
            ? body[0].PostOffice || []
            : [];
        cache.set(key, list);
        return list;
      } catch (err) {
        return null; // unreachable or timed out: the fields still work by hand
      } finally {
        clearTimeout(timer);
      }
    }

    function refreshCitySuggestions() {
      const names = offices
        .flatMap((o) => [cleanOfficeName(o.Name), o.Block])
        .filter(Boolean);
      fillList($(p + "_city_list"), names);
    }
    function refreshAreaSuggestions() {
      const city = norm(cityInput.value);
      const matching = city
        ? offices.filter(
            (o) =>
              norm(cleanOfficeName(o.Name)) === city || norm(o.Block) === city,
          )
        : offices;
      const pool = matching.length ? matching : offices;
      fillList(
        $(p + "_area_list"),
        pool.map((o) => o.Name),
      );
    }

    let cityTimer = null;
    cityInput.addEventListener("input", () => {
      clearTimeout(cityTimer);
      setHint(cityInput, p + "_city_hint", "");
      cityTimer = setTimeout(async () => {
        if (!currentDistrict() || cityInput.value.trim().length < 3) return;
        const list = await lookupOffices(cityInput.value);
        if (list === null) {
          setHint(
            cityInput,
            p + "_city_hint",
            "Suggestions are unavailable right now. Type the village or city name.",
          );
          return;
        }
        offices = filterOffices(list);
        refreshCitySuggestions();
        refreshAreaSuggestions();
        if (!offices.length)
          setHint(
            cityInput,
            p + "_city_hint",
            "No match found. You can type the name as it is.",
          );
      }, 350);
    });

    let areaTimer = null;
    areaInput.addEventListener("input", () => {
      clearTimeout(areaTimer);
      setHint(areaInput, p + "_area_hint", "");
      applyAreaPin();
      areaTimer = setTimeout(async () => {
        if (
          !currentDistrict() ||
          areaInput.value.trim().length < 3 ||
          offices.length
        )
          return;
        const list = await lookupOffices(areaInput.value);
        if (list === null) {
          setHint(
            areaInput,
            p + "_area_hint",
            "Suggestions are unavailable right now. Type the area name.",
          );
          return;
        }
        offices = filterOffices(list);
        refreshAreaSuggestions();
        refreshCitySuggestions();
        applyAreaPin();
      }, 350);
    });
    areaInput.addEventListener("change", applyAreaPin);

    // ---------- PIN suggestion ----------
    let pinIsSuggested = false;
    function clearAutoPin() {
      if (pinIsSuggested) {
        pinInput.value = "";
        pinIsSuggested = false;
      }
    }
    function applyAreaPin() {
      const area = norm(areaInput.value);
      if (!area) {
        clearAutoPin();
        return;
      }
      const office =
        offices.find((o) => norm(o.Name) === area) ||
        offices.find((o) => norm(cleanOfficeName(o.Name)) === area);
      if (!office || !/^\d{6}$/.test(String(office.Pincode || ""))) return;
      if (pinInput.value && !pinIsSuggested) return; // never overwrite a PIN the visitor typed
      pinInput.value = office.Pincode;
      pinIsSuggested = true;
      setHint(
        pinInput,
        p + "_pin_hint",
        "Suggested from the area you chose. You can change it.",
      );
    }
    pinInput.addEventListener("input", () => {
      if (pinIsSuggested && pinInput.value !== "") pinIsSuggested = false;
      setHint(pinInput, p + "_pin_hint", "");
    });
    areaInput.addEventListener("blur", () => {
      if (!pinInput.value) applyAreaPin();
    });

    validateState();
    validateDistrict();
  }
})();
