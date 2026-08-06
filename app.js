/* =========================================================
   Expense Tracker — Application Logic (v2)
   Vanilla JS, LocalStorage persistence, offline-first.

   v2 change: storage moved from a single flat
   {income, expenses} shape to a month-based history:

     {
       currentMonth: "2026-08",
       months: {
         "2026-08": { income: 75000, expenses: [...] },
         "2026-09": { income: 80000, expenses: [...] }
       }
     }

   A one-time migration (see MIGRATION section) converts any
   existing v1 data into this shape the first time v2 code runs,
   without ever touching data that has already been migrated.
   ========================================================= */

(() => {
  "use strict";

  /* ---------------------------------------------------------
     Storage keys
     --------------------------------------------------------- */

  // v1 (legacy, flat, single-month) keys — read-only, used for migration.
  const LEGACY_KEYS = {
    income: "expenseTracker.income",
    expenses: "expenseTracker.expenses",
  };

  // v2 (current) key — the entire app state lives under one key so it can
  // be written atomically (no risk of income and months getting out of sync).
  const DATA_KEY = "expenseTracker.data";

  // Used to stamp exported backups and to sanity-check imported ones.
  // Bumping this does NOT change the LocalStorage format above.
  const APP_VERSION = "2.0.0";
  const BACKUP_FORMAT = "expense-tracker-backup";

  const readJSON = (key, fallback) => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      console.warn("Failed to read storage key", key, e);
      return fallback;
    }
  };

  const writeJSON = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.warn("Failed to write storage key", key, e);
      return false;
    }
  };

  /* ---------------------------------------------------------
     Month key helpers ("YYYY-MM")
     --------------------------------------------------------- */

  const monthKeyOf = (date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

  const currentMonthKey = () => monthKeyOf(new Date());

  const monthKeyToLabel = (key) => {
    const [y, m] = key.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString("en-IN", {
      month: "long",
      year: "numeric",
    });
  };

  const addMonthsToKey = (key, delta) => {
    const [y, m] = key.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return monthKeyOf(d);
  };

  /* ---------------------------------------------------------
     MIGRATION — v1 (flat) -> v2 (month-based)

     Runs automatically, exactly once, with no user interaction.

     Rules enforced here:
       1. Only migrates if v2 data does NOT already exist (idempotent —
          safe to call on every launch, it only does real work once).
       2. Reads the old keys, never mutates them until the new format
          has been written and verified.
       3. The user's existing income/expenses become the *first* month
          in history, keyed by the current calendar month.
       4. Old keys are removed ONLY after the new format is confirmed
          saved (readback check), so a failed write never loses data.
       5. Never invents or duplicates expenses — the old expenses array
          is copied across as-is, once.
     --------------------------------------------------------- */

  const migrateLegacyDataIfNeeded = () => {
    // Step 1: if v2 data already exists, migration already happened (or
    // this is not a legacy user) — do nothing.
    const alreadyMigrated = localStorage.getItem(DATA_KEY) !== null;
    if (alreadyMigrated) return;

    const hasLegacyIncome = localStorage.getItem(LEGACY_KEYS.income) !== null;
    const hasLegacyExpenses = localStorage.getItem(LEGACY_KEYS.expenses) !== null;

    if (!hasLegacyIncome && !hasLegacyExpenses) {
      // Fresh install — nothing to migrate, v2 will initialize normally.
      return;
    }

    // Step 2: read the legacy values defensively.
    const legacyIncome = readJSON(LEGACY_KEYS.income, null);
    const legacyExpenses = readJSON(LEGACY_KEYS.expenses, []);
    const safeExpenses = Array.isArray(legacyExpenses) ? legacyExpenses : [];

    // Step 3: the existing data becomes the first month in history,
    // labeled with the current calendar month (e.g. "2026-08").
    const monthKey = currentMonthKey();
    const migratedData = {
      currentMonth: monthKey,
      months: {
        [monthKey]: {
          income: legacyIncome,
          expenses: safeExpenses,
        },
      },
    };

    // Step 4: write the new format, then verify it actually landed before
    // touching the old keys. If the write or verification fails, we bail
    // out and keep the legacy keys intact — the app still falls back to
    // reading them next launch since DATA_KEY won't exist.
    const writeOk = writeJSON(DATA_KEY, migratedData);
    const verify = readJSON(DATA_KEY, null);
    const verifyOk =
      writeOk &&
      verify &&
      verify.months &&
      verify.months[monthKey] &&
      Array.isArray(verify.months[monthKey].expenses) &&
      verify.months[monthKey].expenses.length === safeExpenses.length;

    if (verifyOk) {
      // Step 5: only now is it safe to remove the old, now-redundant keys.
      localStorage.removeItem(LEGACY_KEYS.income);
      localStorage.removeItem(LEGACY_KEYS.expenses);
      console.info(
        `[migration] Legacy data migrated into month "${monthKey}" and old keys removed.`
      );
    } else {
      console.warn(
        "[migration] Could not verify migrated data — legacy keys were kept as a safety net."
      );
    }
  };

  migrateLegacyDataIfNeeded();

  /* ---------------------------------------------------------
     State
     --------------------------------------------------------- */

  const loadedData = readJSON(DATA_KEY, null);

  const state = loadedData
    ? loadedData
    : {
        currentMonth: currentMonthKey(),
        months: {},
      };

  const saveData = () => writeJSON(DATA_KEY, state);

  // Ensure a month record exists (used for the current month, and for any
  // month the user navigates to) — never overwrites existing data.
  const ensureMonth = (key) => {
    if (!state.months[key]) {
      state.months[key] = { income: null, expenses: [] };
    }
    return state.months[key];
  };

  ensureMonth(state.currentMonth);

  const sortedMonthKeys = () => Object.keys(state.months).sort();

  const getCurrentMonthData = () => ensureMonth(state.currentMonth);

  let pendingEditId = null; // expense currently being edited (null = adding new)
  let pendingDeleteId = null; // expense pending delete confirmation
  let pendingActionMonthKey = null; // month key targeted by the ⋮ action sheet / delete confirm
  let selectedType = "recurring"; // currently selected type in the expense sheet

  /* ---------------------------------------------------------
     DOM references
     --------------------------------------------------------- */
  const $ = (id) => document.getElementById(id);

  const els = {
    savingsAmount: $("savingsAmount"),
    heroSub: $("heroSub"),
    incomeValue: $("incomeValue"),
    expensesValue: $("expensesValue"),
    rateValue: $("rateValue"),
    incomeStat: $("incomeStat"),

    monthLabel: $("monthLabel"),
    monthSelectorBtn: $("monthSelectorBtn"),

    monthPickerOverlay: $("monthPickerOverlay"),
    monthPickerList: $("monthPickerList"),
    createMonthBtn: $("createMonthBtn"),

    monthActionOverlay: $("monthActionOverlay"),
    deleteMonthMenuBtn: $("deleteMonthMenuBtn"),
    cancelMonthActionBtn: $("cancelMonthActionBtn"),

    deleteMonthOverlay: $("deleteMonthOverlay"),
    deleteMonthName: $("deleteMonthName"),
    cancelDeleteMonthBtn: $("cancelDeleteMonthBtn"),
    confirmDeleteMonthBtn: $("confirmDeleteMonthBtn"),

    downloadPdfBtn: $("downloadPdfBtn"),
    downloadPdfSub: $("downloadPdfSub"),
    addExpenseBtn: $("addExpenseBtn"),

    backupBtn: $("backupBtn"),
    backupOverlay: $("backupOverlay"),
    exportBackupBtn: $("exportBackupBtn"),
    importBackupBtn: $("importBackupBtn"),
    cancelBackupBtn: $("cancelBackupBtn"),
    importFileInput: $("importFileInput"),

    importConfirmOverlay: $("importConfirmOverlay"),
    cancelImportBtn: $("cancelImportBtn"),
    confirmImportBtn: $("confirmImportBtn"),

    recurringGroup: $("recurringGroup"),
    recurringList: $("recurringList"),
    recurringTotal: $("recurringTotal"),
    oneTimeGroup: $("oneTimeGroup"),
    oneTimeList: $("oneTimeList"),
    oneTimeTotal: $("oneTimeTotal"),
    emptyState: $("emptyState"),

    incomeOverlay: $("incomeOverlay"),
    incomeInput: $("incomeInput"),
    incomeDesc: $("incomeDesc"),
    saveIncomeBtn: $("saveIncomeBtn"),

    expenseOverlay: $("expenseOverlay"),
    expenseTitle: $("expenseTitle"),
    expenseNameInput: $("expenseNameInput"),
    expenseAmountInput: $("expenseAmountInput"),
    expenseTypeSegment: $("expenseTypeSegment"),
    saveExpenseBtn: $("saveExpenseBtn"),
    cancelExpenseBtn: $("cancelExpenseBtn"),

    deleteOverlay: $("deleteOverlay"),
    deleteDesc: $("deleteDesc"),
    cancelDeleteBtn: $("cancelDeleteBtn"),
    confirmDeleteBtn: $("confirmDeleteBtn"),

    toast: $("toast"),
  };

  /* ---------------------------------------------------------
     Utilities
     --------------------------------------------------------- */
  const formatINR = (num) => {
    const n = Math.round((num + Number.EPSILON) * 100) / 100;
    return n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
  };

  const uid = () =>
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  const todayLabel = () => {
    const d = new Date();
    return d.toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  };

  let toastTimer = null;
  const showToast = (message) => {
    els.toast.textContent = "";
    const dot = document.createElement("span");
    dot.className = "dot";
    const text = document.createElement("span");
    text.textContent = message;
    els.toast.appendChild(dot);
    els.toast.appendChild(text);
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2200);
  };

  /* ---------------------------------------------------------
     Icons per expense name (best-effort keyword match)
     --------------------------------------------------------- */
  const ICONS = {
    rent: `<svg viewBox="0 0 24 24" fill="none"><path d="M3 11L12 4L21 11" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 10V19C5 19.5523 5.44772 20 6 20H18C18.5523 20 19 19.5523 19 19V10" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M10 20V14H14V20" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`,
    internet: `<svg viewBox="0 0 24 24" fill="none"><path d="M3.5 8.5C9 3.5 15 3.5 20.5 8.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M6.5 12C10 9 14 9 17.5 12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M9.5 15.5C11.3 14 12.7 14 14.5 15.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="12" cy="18.5" r="1.1" fill="currentColor"/></svg>`,
    wifi: `<svg viewBox="0 0 24 24" fill="none"><path d="M3.5 8.5C9 3.5 15 3.5 20.5 8.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M6.5 12C10 9 14 9 17.5 12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M9.5 15.5C11.3 14 12.7 14 14.5 15.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="12" cy="18.5" r="1.1" fill="currentColor"/></svg>`,
    grocer: `<svg viewBox="0 0 24 24" fill="none"><path d="M3 4H5L6.2 14.4C6.32 15.42 7.18 16.2 8.21 16.2H17.5C18.5 16.2 19.35 15.47 19.5 14.48L20.5 8H6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9" cy="20" r="1.2" fill="currentColor"/><circle cx="17" cy="20" r="1.2" fill="currentColor"/></svg>`,
    food: `<svg viewBox="0 0 24 24" fill="none"><path d="M6 3V10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M4 3V8C4 9.1 4.9 10 6 10C7.1 10 8 9.1 8 8V3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M6 10V21" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M17 3C15 3 14 5.5 14 8C14 9.5 14.7 10.5 16 11V21" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    spotify: `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9.2" stroke="currentColor" stroke-width="1.6"/><path d="M7 10C10.5 8.7 14.3 9 17.3 10.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M7.6 13C10.4 12 13.5 12.3 16 13.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M8.3 16C10.4 15.3 12.7 15.5 14.6 16.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    music: `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9.2" stroke="currentColor" stroke-width="1.6"/><path d="M7 10C10.5 8.7 14.3 9 17.3 10.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M7.6 13C10.4 12 13.5 12.3 16 13.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M8.3 16C10.4 15.3 12.7 15.5 14.6 16.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    netflix: `<svg viewBox="0 0 24 24" fill="none"><rect x="5" y="3" width="14" height="18" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M9 7V17L15 7V17" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
    movie: `<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="6" width="18" height="13" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M7 6L9 3H15L17 6" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 6V19" stroke="currentColor" stroke-width="1.4"/><path d="M16 6V19" stroke="currentColor" stroke-width="1.4"/></svg>`,
    fuel: `<svg viewBox="0 0 24 24" fill="none"><path d="M4 21V6C4 4.9 4.9 4 6 4H12C13.1 4 14 4.9 14 6V21" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M4 21H14" stroke="currentColor" stroke-width="1.6"/><path d="M14 9H16.5L19 12V17.5C19 18.3 18.3 19 17.5 19C16.7 19 16 18.3 16 17.5V15" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M7 8H11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
    petrol: `<svg viewBox="0 0 24 24" fill="none"><path d="M4 21V6C4 4.9 4.9 4 6 4H12C13.1 4 14 4.9 14 6V21" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M4 21H14" stroke="currentColor" stroke-width="1.6"/><path d="M14 9H16.5L19 12V17.5C19 18.3 18.3 19 17.5 19C16.7 19 16 18.3 16 17.5V15" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
    bike: `<svg viewBox="0 0 24 24" fill="none"><circle cx="6" cy="17" r="3.2" stroke="currentColor" stroke-width="1.6"/><circle cx="18" cy="17" r="3.2" stroke="currentColor" stroke-width="1.6"/><path d="M6 17L10 9H14L18 17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 9H15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M13 9L11 17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
    car: `<svg viewBox="0 0 24 24" fill="none"><path d="M4 16L5.5 10.5C5.75 9.6 6.57 9 7.5 9H16.5C17.43 9 18.25 9.6 18.5 10.5L20 16" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><rect x="2.5" y="16" width="19" height="4" rx="1.4" stroke="currentColor" stroke-width="1.6"/><circle cx="6.5" cy="20" r="1.1" fill="currentColor"/><circle cx="17.5" cy="20" r="1.1" fill="currentColor"/></svg>`,
    shoe: `<svg viewBox="0 0 24 24" fill="none"><path d="M3 16.5C3 15 4.2 14 5.5 13.5L10 12L15 9.5C16.2 9 17.5 9.6 18 10.7L19 13H21V17C21 18.1 20.1 19 19 19H4C3.4 19 3 18.6 3 18V16.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
    shopping: `<svg viewBox="0 0 24 24" fill="none"><path d="M6 8H18L17.2 19.2C17.13 20.19 16.3 21 15.3 21H8.7C7.7 21 6.87 20.19 6.8 19.2L6 8Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 8V6C9 4.34315 10.3431 3 12 3C13.6569 3 15 4.34315 15 6V8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
    bag: `<svg viewBox="0 0 24 24" fill="none"><path d="M6 8H18L17.2 19.2C17.13 20.19 16.3 21 15.3 21H8.7C7.7 21 6.87 20.19 6.8 19.2L6 8Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 8V6C9 4.34315 10.3431 3 12 3C13.6569 3 15 4.34315 15 6V8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
    health: `<svg viewBox="0 0 24 24" fill="none"><path d="M12 21C12 21 4 15.5 4 9.7C4 6.9 6.2 4.7 9 4.7C10.5 4.7 11.5 5.4 12 6.2C12.5 5.4 13.5 4.7 15 4.7C17.8 4.7 20 6.9 20 9.7C20 15.5 12 21 12 21Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
    medic: `<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="4" width="16" height="16" rx="4" stroke="currentColor" stroke-width="1.6"/><path d="M12 8V16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M8 12H16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
    gym: `<svg viewBox="0 0 24 24" fill="none"><path d="M4 12H2.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M21.5 12H20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><rect x="4" y="9" width="3" height="6" rx="0.8" stroke="currentColor" stroke-width="1.6"/><rect x="17" y="9" width="3" height="6" rx="0.8" stroke="currentColor" stroke-width="1.6"/><path d="M7 12H17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
    travel: `<svg viewBox="0 0 24 24" fill="none"><path d="M10.5 3.5L3.5 10.5L8 11.5L12.5 16L13.5 8.5L20.5 3.5L16.5 10.5L21 12L14 20.5L12.5 15.5L8 20L8.5 15.5L3.5 14L10.5 3.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
    flight: `<svg viewBox="0 0 24 24" fill="none"><path d="M10.5 3.5L3.5 10.5L8 11.5L12.5 16L13.5 8.5L20.5 3.5L16.5 10.5L21 12L14 20.5L12.5 15.5L8 20L8.5 15.5L3.5 14L10.5 3.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
    phone: `<svg viewBox="0 0 24 24" fill="none"><rect x="7" y="3" width="10" height="18" rx="2.4" stroke="currentColor" stroke-width="1.6"/><path d="M11 18H13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
    electric: `<svg viewBox="0 0 24 24" fill="none"><path d="M12.5 3L4 14H11L10 21L19 9H12L12.5 3Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
    bill: `<svg viewBox="0 0 24 24" fill="none"><path d="M12.5 3L4 14H11L10 21L19 9H12L12.5 3Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
    insurance: `<svg viewBox="0 0 24 24" fill="none"><path d="M12 3L19 6V11C19 15.5 16 19 12 21C8 19 5 15.5 5 11V6L12 3Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9.3 12L11.3 14L14.7 10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    loan: `<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="6" width="18" height="12" rx="2" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="2.6" stroke="currentColor" stroke-width="1.5"/></svg>`,
    subscri: `<svg viewBox="0 0 24 24" fill="none"><path d="M4 12C4 7.58172 7.58172 4 12 4C15.0264 4 17.6544 5.69072 19 8.19168" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M20 4V8.5H15.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 12C20 16.4183 16.4183 20 12 20C8.97357 20 6.34558 18.3093 5 15.8083" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M4 20V15.5H8.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    repair: `<svg viewBox="0 0 24 24" fill="none"><path d="M14.7 6.3a4 4 0 015.7 5l-7.2 7.2a2 2 0 01-2.8 0L4.5 12.6a2 2 0 010-2.8L11.7 2.6a4 4 0 015 5.7" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
    service: `<svg viewBox="0 0 24 24" fill="none"><path d="M14.7 6.3a4 4 0 015.7 5l-7.2 7.2a2 2 0 01-2.8 0L4.5 12.6a2 2 0 010-2.8L11.7 2.6a4 4 0 015 5.7" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
  };

  const DEFAULT_ICON = `<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="6" width="18" height="14" rx="3" stroke="currentColor" stroke-width="1.6"/><path d="M3 10H21" stroke="currentColor" stroke-width="1.6"/><circle cx="7" cy="14.5" r="1" fill="currentColor"/></svg>`;

  const iconFor = (name) => {
    const n = name.toLowerCase();
    for (const key of Object.keys(ICONS)) {
      if (n.includes(key)) return ICONS[key];
    }
    return DEFAULT_ICON;
  };

  const deleteIconSVG = `<svg viewBox="0 0 24 24" fill="none"><path d="M4 7H20" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M9 7V4.8C9 4.35817 9.35817 4 9.8 4H14.2C14.6418 4 15 4.35817 15 4.8V7" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M6 7L6.8 19.2C6.87 20.19 7.7 21 8.7 21H15.3C16.3 21 17.13 20.19 17.2 19.2L18 7" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`;
  const editIconSVG = `<svg viewBox="0 0 24 24" fill="none"><path d="M14.7 6.3a4 4 0 015.7 5l-9.2 9.2-5 1 1-5 9.2-9.2" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

  /* ---------------------------------------------------------
     Rotating motivational quotes (hero-sub, below Monthly Savings)

     - Rotates every 3s with a smooth fade-out/fade-in.
     - Random order, but never repeats the immediately-previous quote.
     - Runs independently of renderHero() so re-renders (switching
       months, editing expenses, etc.) never interrupt or reset it.
     --------------------------------------------------------- */
  const MOTIVATIONAL_QUOTES = [
    "Money grows with patience 🌱",
    "Small wins become fortunes ✨",
    "Every rupee has a purpose 💚",
    "Consistency beats intensity ⚡",
    "Saving today, freedom tomorrow 🌿",
    "Little by little, wealth grows 🌳",
    "Progress over perfection 🚀",
    "Future you says thanks 🙌",
    "Smart habits compound daily 📈",
    "Stay steady, stay saving 🌿",
    "You're building something great 💎",
    "Discipline creates freedom 🔥",
    "Track it, then trust it 🧭",
    "Small savings, big dreams 🌟",
    "Every month is a fresh start 🌱",
  ];

  const FADE_MS = 380;
  const ROTATE_MS = 3000;
  let lastQuoteIndex = -1;

  const pickNextQuote = () => {
    if (MOTIVATIONAL_QUOTES.length <= 1) return MOTIVATIONAL_QUOTES[0];
    let idx;
    do {
      idx = Math.floor(Math.random() * MOTIVATIONAL_QUOTES.length);
    } while (idx === lastQuoteIndex);
    lastQuoteIndex = idx;
    return MOTIVATIONAL_QUOTES[idx];
  };

  const rotateQuote = () => {
    els.heroSub.classList.add("fading");
    setTimeout(() => {
      els.heroSub.textContent = pickNextQuote();
      els.heroSub.classList.remove("fading");
    }, FADE_MS);
  };

  const initQuoteRotator = () => {
    els.heroSub.textContent = pickNextQuote();
    setInterval(rotateQuote, ROTATE_MS);
  };

  /* ---------------------------------------------------------
     Derived calculations (always for the SELECTED month)
     --------------------------------------------------------- */
  const totals = () => {
    const monthData = getCurrentMonthData();
    const income = monthData.income || 0;
    let recurring = 0;
    let oneTime = 0;
    for (const e of monthData.expenses) {
      if (e.type === "recurring") recurring += e.amount;
      else oneTime += e.amount;
    }
    const expenses = recurring + oneTime;
    const savings = income - expenses;
    const rate = income > 0 ? (savings / income) * 100 : 0;
    return { income, recurring, oneTime, expenses, savings, rate };
  };

  /* ---------------------------------------------------------
     Rendering
     --------------------------------------------------------- */
  const renderHero = () => {
    const t = totals();

    els.savingsAmount.textContent = formatINR(t.savings);
    els.incomeValue.textContent = formatINR(t.income);
    els.expensesValue.textContent = formatINR(t.expenses);
    const rateClamped = Math.max(-999, Math.min(999, t.rate));
    els.rateValue.textContent = rateClamped.toFixed(1);
    // hero-sub text is no longer state-dependent — see the rotating
    // motivational quotes carousel set up in initQuoteRotator().
  };

  const renderMonthSelector = () => {
    els.monthLabel.textContent = monthKeyToLabel(state.currentMonth);

    if (els.downloadPdfSub) {
      els.downloadPdfSub.textContent = `Export ${monthKeyToLabel(state.currentMonth)}`;
    }
  };

  const buildExpenseCard = (expense) => {
    const card = document.createElement("div");
    card.className = "expense-card";
    card.dataset.id = expense.id;

    const meta =
      expense.type === "recurring" ? "Every month" : expense.date || todayLabel();

    card.innerHTML = `
      <div class="expense-icon">${iconFor(expense.name)}</div>
      <div class="expense-info">
        <span class="expense-name">${escapeHTML(expense.name)}</span>
        <span class="expense-meta">${escapeHTML(meta)}</span>
      </div>
      <div class="expense-amount"><span class="rupee">₹</span>${formatINR(expense.amount)}</div>
      <div class="expense-actions">
        <button class="icon-btn icon-btn--edit" aria-label="Edit ${escapeHTML(expense.name)}">${editIconSVG}</button>
        <button class="icon-btn icon-btn--danger" aria-label="Delete ${escapeHTML(expense.name)}">${deleteIconSVG}</button>
      </div>
    `;

    card.querySelector(".icon-btn--edit").addEventListener("click", () => openEditExpense(expense.id));
    card.querySelector(".icon-btn--danger").addEventListener("click", () => openDeleteConfirm(expense.id));

    return card;
  };

  function escapeHTML(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  const renderExpenses = () => {
    const t = totals();
    const monthData = getCurrentMonthData();

    els.recurringTotal.textContent = formatINR(t.recurring);
    els.oneTimeTotal.textContent = formatINR(t.oneTime);

    els.recurringList.innerHTML = "";
    els.oneTimeList.innerHTML = "";

    const recurring = monthData.expenses.filter((e) => e.type === "recurring");
    const oneTime = monthData.expenses.filter((e) => e.type === "onetime");

    recurring.forEach((e) => els.recurringList.appendChild(buildExpenseCard(e)));
    oneTime.forEach((e) => els.oneTimeList.appendChild(buildExpenseCard(e)));

    els.recurringGroup.hidden = recurring.length === 0;
    els.oneTimeGroup.hidden = oneTime.length === 0;
    els.emptyState.hidden = monthData.expenses.length !== 0;
  };

  const renderAll = () => {
    renderMonthSelector();
    renderHero();
    renderExpenses();
  };

  /* ---------------------------------------------------------
     Sheet / Modal helpers
     --------------------------------------------------------- */
  const openSheet = (overlay) => {
    overlay.classList.add("open");
    document.body.style.overflow = "hidden";
  };
  const closeSheet = (overlay) => {
    overlay.classList.remove("open");
    // Restore scroll only if nothing else is open
    const anyOpen = document.querySelector(".sheet-overlay.open");
    if (!anyOpen) document.body.style.overflow = "";
  };

  // Close on backdrop click
  [
    els.incomeOverlay,
    els.expenseOverlay,
    els.deleteOverlay,
    els.monthPickerOverlay,
    els.monthActionOverlay,
    els.deleteMonthOverlay,
    els.backupOverlay,
    els.importConfirmOverlay,
  ].forEach((overlay) => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeSheet(overlay);
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      document.querySelectorAll(".sheet-overlay.open").forEach(closeSheet);
    }
  });

  /* ---------------------------------------------------------
     Month switching (shared by the picker + month creation)
     --------------------------------------------------------- */
  const switchMonth = (key) => {
    ensureMonth(key);
    state.currentMonth = key;
    saveData();
    renderAll();
  };

  const checkIconSVG = `<svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5L9.5 17L19 6.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const menuDotsSVG = `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="5.5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="18.5" r="1.6" fill="currentColor"/></svg>`;

  /* ---------------------------------------------------------
     Month Picker sheet — lists every stored month, newest first
     --------------------------------------------------------- */
  const renderMonthPickerList = () => {
    // Newest first, per spec — sortedMonthKeys() is ascending, so reverse it.
    const keysNewestFirst = [...sortedMonthKeys()].reverse();

    els.monthPickerList.innerHTML = "";

    keysNewestFirst.forEach((key) => {
      const isSelected = key === state.currentMonth;

      const row = document.createElement("div");
      row.className = `month-row${isSelected ? " selected" : ""}`;
      row.dataset.key = key;

      row.innerHTML = `
        <button class="month-row-select" type="button">
          <span class="month-row-check">${isSelected ? checkIconSVG : ""}</span>
          <span class="month-row-label">${escapeHTML(monthKeyToLabel(key))}</span>
        </button>
        <button class="month-row-menu" type="button" aria-label="More options for ${escapeHTML(monthKeyToLabel(key))}">
          ${menuDotsSVG}
        </button>
      `;

      row.querySelector(".month-row-select").addEventListener("click", () => {
        switchMonth(key);
        closeSheet(els.monthPickerOverlay);
      });

      row.querySelector(".month-row-menu").addEventListener("click", (e) => {
        e.stopPropagation();
        pendingActionMonthKey = key;
        closeSheet(els.monthPickerOverlay);
        openSheet(els.monthActionOverlay);
      });

      els.monthPickerList.appendChild(row);
    });
  };

  const openMonthPicker = () => {
    renderMonthPickerList();
    openSheet(els.monthPickerOverlay);
  };

  els.monthSelectorBtn.addEventListener("click", openMonthPicker);

  /* ---------------------------------------------------------
     Create New Month
     (suggests the next chronological month after the most recent
     one on record; copies Income + Recurring Expenses, excludes
     One-time Expenses, then switches to it immediately)
     --------------------------------------------------------- */
  const createNewMonth = () => {
    const keys = sortedMonthKeys(); // ascending
    const latestKey = keys[keys.length - 1];
    const newKey = addMonthsToKey(latestKey, 1);

    // Guard against ever duplicating/overwriting an existing month.
    if (state.months[newKey]) {
      switchMonth(newKey);
      return;
    }

    const sourceData = state.months[latestKey];

    // Recurring expenses become independent records in the new month —
    // cloned with brand-new ids so editing one never touches the other.
    const clonedRecurring = sourceData.expenses
      .filter((e) => e.type === "recurring")
      .map((e) => ({
        id: uid(),
        name: e.name,
        amount: e.amount,
        type: "recurring",
        date: todayLabel(),
      }));

    // The source month is left completely untouched — only ever read above.
    state.months[newKey] = {
      income: sourceData.income, // copied, independent from here on
      expenses: clonedRecurring, // one-time expenses intentionally excluded
    };

    state.currentMonth = newKey;
    saveData();
    renderAll();
    showToast(`${monthKeyToLabel(newKey)} created`);
  };

  els.createMonthBtn.addEventListener("click", () => {
    closeSheet(els.monthPickerOverlay);
    createNewMonth();
  });

  /* ---------------------------------------------------------
     Month row ⋮ action sheet (Delete Month / Cancel)
     --------------------------------------------------------- */
  els.cancelMonthActionBtn.addEventListener("click", () => {
    pendingActionMonthKey = null;
    closeSheet(els.monthActionOverlay);
  });

  els.deleteMonthMenuBtn.addEventListener("click", () => {
    if (!pendingActionMonthKey) return;

    // Never allow deleting the last remaining month.
    if (Object.keys(state.months).length <= 1) {
      closeSheet(els.monthActionOverlay);
      pendingActionMonthKey = null;
      showToast("You can't delete your only month");
      return;
    }

    els.deleteMonthName.textContent = monthKeyToLabel(pendingActionMonthKey);
    closeSheet(els.monthActionOverlay);
    openSheet(els.deleteMonthOverlay);
  });

  /* ---------------------------------------------------------
     Delete Month confirmation
     --------------------------------------------------------- */
  els.cancelDeleteMonthBtn.addEventListener("click", () => {
    pendingActionMonthKey = null;
    closeSheet(els.deleteMonthOverlay);
  });

  els.confirmDeleteMonthBtn.addEventListener("click", () => {
    if (!pendingActionMonthKey) return;

    const keys = Object.keys(state.months);
    if (keys.length <= 1) {
      // Safety net — should be unreachable since the menu already guards this.
      closeSheet(els.deleteMonthOverlay);
      pendingActionMonthKey = null;
      showToast("You can't delete your only month");
      return;
    }

    const deletedKey = pendingActionMonthKey;
    const wasCurrent = deletedKey === state.currentMonth;

    // Delete only this month's data — every other month is untouched.
    delete state.months[deletedKey];

    if (wasCurrent) {
      // Automatically switch to the most recent remaining month.
      const remaining = Object.keys(state.months).sort();
      state.currentMonth = remaining[remaining.length - 1];
    }

    saveData();
    pendingActionMonthKey = null;
    closeSheet(els.deleteMonthOverlay);
    renderAll();
    showToast(`${monthKeyToLabel(deletedKey)} deleted`);
  });

  /* ---------------------------------------------------------
     Income modal (edits ONLY the selected month's income)
     --------------------------------------------------------- */
  const openIncomeModal = (isFirstLaunch = false) => {
    const monthData = getCurrentMonthData();
    els.incomeInput.value = monthData.income ?? "";
    els.incomeDesc.textContent = isFirstLaunch
      ? "Welcome! Let's set up your monthly income to get started."
      : `How much do you earn in ${monthKeyToLabel(state.currentMonth)}? You can update this anytime.`;
    openSheet(els.incomeOverlay);
    setTimeout(() => els.incomeInput.focus(), 260);
  };

  els.incomeStat.addEventListener("click", () => openIncomeModal(false));

  els.saveIncomeBtn.addEventListener("click", () => {
    const val = parseFloat(els.incomeInput.value);
    if (isNaN(val) || val < 0) {
      els.incomeInput.focus();
      showToast("Enter a valid income amount");
      return;
    }
    getCurrentMonthData().income = val;
    saveData();
    closeSheet(els.incomeOverlay);
    renderAll();
    document.getElementById("heroCard").classList.remove("pulse");
    void els.savingsAmount.offsetWidth;
    document.getElementById("heroCard").classList.add("pulse");
    showToast("Income updated");
  });

  els.incomeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") els.saveIncomeBtn.click();
  });

  /* ---------------------------------------------------------
     Expense sheet (add / edit) — always targets the selected month
     --------------------------------------------------------- */
  const setSelectedType = (type) => {
    selectedType = type;
    els.expenseTypeSegment.querySelectorAll(".segment").forEach((btn) => {
      const active = btn.dataset.type === type;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-checked", String(active));
    });
  };

  els.expenseTypeSegment.querySelectorAll(".segment").forEach((btn) => {
    btn.addEventListener("click", () => setSelectedType(btn.dataset.type));
  });

  const openAddExpense = () => {
    pendingEditId = null;
    els.expenseTitle.textContent = "Add Expense";
    els.expenseNameInput.value = "";
    els.expenseAmountInput.value = "";
    setSelectedType("recurring");
    openSheet(els.expenseOverlay);
    setTimeout(() => els.expenseNameInput.focus(), 260);
  };

  const openEditExpense = (id) => {
    const expense = getCurrentMonthData().expenses.find((e) => e.id === id);
    if (!expense) return;
    pendingEditId = id;
    els.expenseTitle.textContent = "Edit Expense";
    els.expenseNameInput.value = expense.name;
    els.expenseAmountInput.value = expense.amount;
    setSelectedType(expense.type);
    openSheet(els.expenseOverlay);
    setTimeout(() => els.expenseNameInput.focus(), 260);
  };

  els.addExpenseBtn.addEventListener("click", openAddExpense);
  els.cancelExpenseBtn.addEventListener("click", () => closeSheet(els.expenseOverlay));

  els.saveExpenseBtn.addEventListener("click", () => {
    const name = els.expenseNameInput.value.trim();
    const amount = parseFloat(els.expenseAmountInput.value);

    if (!name) {
      els.expenseNameInput.focus();
      showToast("Enter an expense name");
      return;
    }
    if (isNaN(amount) || amount <= 0) {
      els.expenseAmountInput.focus();
      showToast("Enter a valid amount");
      return;
    }

    const monthData = getCurrentMonthData();

    if (pendingEditId) {
      const expense = monthData.expenses.find((e) => e.id === pendingEditId);
      if (expense) {
        expense.name = name;
        expense.amount = amount;
        expense.type = selectedType;
      }
      showToast("Expense updated");
    } else {
      monthData.expenses.unshift({
        id: uid(),
        name,
        amount,
        type: selectedType,
        date: todayLabel(),
      });
      showToast("Expense added");
    }

    saveData();
    closeSheet(els.expenseOverlay);
    renderAll();
  });

  /* ---------------------------------------------------------
     Delete confirmation — deletes only from the selected month
     --------------------------------------------------------- */
  const openDeleteConfirm = (id) => {
    const expense = getCurrentMonthData().expenses.find((e) => e.id === id);
    if (!expense) return;
    pendingDeleteId = id;
    els.deleteDesc.innerHTML = `This will permanently remove <strong>${escapeHTML(expense.name)}</strong>.`;
    openSheet(els.deleteOverlay);
  };

  els.cancelDeleteBtn.addEventListener("click", () => {
    pendingDeleteId = null;
    closeSheet(els.deleteOverlay);
  });

  els.confirmDeleteBtn.addEventListener("click", () => {
    if (!pendingDeleteId) return;
    const cardEl = document.querySelector(`.expense-card[data-id="${pendingDeleteId}"]`);
    const idToDelete = pendingDeleteId;
    closeSheet(els.deleteOverlay);

    const finish = () => {
      const monthData = getCurrentMonthData();
      monthData.expenses = monthData.expenses.filter((e) => e.id !== idToDelete);
      saveData();
      renderAll();
      showToast("Expense deleted");
    };

    if (cardEl) {
      cardEl.classList.add("removing");
      setTimeout(finish, 260);
    } else {
      finish();
    }
    pendingDeleteId = null;
  });

  /* ---------------------------------------------------------
     Group collapsing
     --------------------------------------------------------- */
  document.querySelectorAll(".group-header").forEach((header) => {
    header.addEventListener("click", () => {
      const group = header.closest(".expense-group");
      group.classList.toggle("collapsed");
    });
  });

  /* ---------------------------------------------------------
     PDF export — always exports the currently selected month
     --------------------------------------------------------- */
  const buildPDF = () => {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const t = totals();
    const monthData = getCurrentMonthData();
    const monthLabel = monthKeyToLabel(state.currentMonth);

    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 48;
    let y = 64;

    const GREEN = [57, 255, 20];
    const DARK = [11, 11, 11];
    const GRAY = [110, 110, 110];
    const BLACK = [20, 20, 20];

    // Header band
    doc.setFillColor(...DARK);
    doc.rect(0, 0, pageWidth, 110, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(24);
    doc.text("Expense Tracker", margin, 54);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.setTextColor(180, 180, 180);
    doc.text(`Monthly Report — ${monthLabel}`, margin, 74);
    doc.setTextColor(...GREEN);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text(`Generated ${todayLabel()}`, pageWidth - margin, 54, { align: "right" });

    y = 140;

    // Summary cards
    const cardW = (pageWidth - margin * 2 - 24) / 3;
    const summaryData = [
      ["Income", `Rs. ${formatINR(t.income)}`],
      ["Total Expenses", `Rs. ${formatINR(t.expenses)}`],
      ["Savings", `Rs. ${formatINR(t.savings)}`],
    ];
    summaryData.forEach((item, i) => {
      const x = margin + i * (cardW + 12);
      doc.setDrawColor(225, 225, 225);
      doc.setFillColor(247, 247, 247);
      doc.roundedRect(x, y, cardW, 64, 8, 8, "FD");
      doc.setTextColor(...GRAY);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9.5);
      doc.text(item[0].toUpperCase(), x + 14, y + 24);
      doc.setTextColor(...BLACK);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(15);
      doc.text(item[1], x + 14, y + 46);
    });

    y += 90;

    // Savings rate line
    doc.setDrawColor(225, 225, 225);
    doc.setLineWidth(1);
    doc.line(margin, y, pageWidth - margin, y);
    y += 24;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...BLACK);
    doc.text("Savings Rate", margin, y);
    doc.setTextColor(...GREEN);
    doc.text(`${t.rate.toFixed(1)}%`, pageWidth - margin, y, { align: "right" });
    y += 30;

    const drawSectionTable = (title, items, total) => {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(13);
      doc.setTextColor(...BLACK);
      doc.text(title, margin, y);
      doc.setTextColor(...GREEN);
      doc.text(`Rs. ${formatINR(total)}`, pageWidth - margin, y, { align: "right" });
      y += 12;
      doc.setDrawColor(230, 230, 230);
      doc.line(margin, y, pageWidth - margin, y);
      y += 18;

      if (items.length === 0) {
        doc.setFont("helvetica", "italic");
        doc.setFontSize(10.5);
        doc.setTextColor(...GRAY);
        doc.text("No expenses in this category.", margin, y);
        y += 22;
        return;
      }

      items.forEach((item, idx) => {
        if (y > 760) {
          doc.addPage();
          y = 60;
        }
        const rowBg = idx % 2 === 0 ? [250, 250, 250] : [255, 255, 255];
        doc.setFillColor(...rowBg);
        doc.rect(margin, y - 14, pageWidth - margin * 2, 24, "F");
        doc.setFont("helvetica", "normal");
        doc.setFontSize(10.5);
        doc.setTextColor(...BLACK);
        doc.text(item.name, margin + 8, y + 2);
        doc.setTextColor(...GRAY);
        doc.setFontSize(9);
        doc.text(item.type === "recurring" ? "Every month" : item.date || "", margin + 8, y - 10 + 22, { baseline: "top" });
        doc.setFont("helvetica", "bold");
        doc.setFontSize(10.5);
        doc.setTextColor(...BLACK);
        doc.text(`Rs. ${formatINR(item.amount)}`, pageWidth - margin - 8, y + 2, { align: "right" });
        y += 26;
      });
      y += 12;
    };

    const recurring = monthData.expenses.filter((e) => e.type === "recurring");
    const oneTime = monthData.expenses.filter((e) => e.type === "onetime");

    drawSectionTable("Recurring Expenses", recurring, t.recurring);
    drawSectionTable("One-time Expenses", oneTime, t.oneTime);

    // Footer summary band
    if (y > 700) {
      doc.addPage();
      y = 60;
    }
    doc.setFillColor(...DARK);
    doc.roundedRect(margin, y, pageWidth - margin * 2, 70, 10, 10, "F");
    doc.setTextColor(...GREEN);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text("MONTHLY SAVINGS", margin + 18, y + 28);
    doc.setFontSize(22);
    doc.text(`Rs. ${formatINR(t.savings)}`, margin + 18, y + 54);
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10.5);
    doc.text(`${t.rate.toFixed(1)}% of income saved`, pageWidth - margin - 18, y + 40, { align: "right" });

    return { doc, monthLabel };
  };

  els.downloadPdfBtn.addEventListener("click", () => {
    try {
      if (!window.jspdf) {
        showToast("PDF library not available offline yet");
        return;
      }
      const { doc, monthLabel } = buildPDF();
      const filename = `Expense_Report_${monthLabel.replace(" ", "_")}.pdf`;
      doc.save(filename);
      showToast("PDF downloaded");
    } catch (err) {
      console.error(err);
      showToast("Could not generate PDF");
    }
  });

  /* ---------------------------------------------------------
     Backup — Export / Import ALL application data
     (does not alter DATA_KEY's on-disk shape; only reads/writes it)
     --------------------------------------------------------- */

  const todayISODate = () => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };

  els.backupBtn.addEventListener("click", () => openSheet(els.backupOverlay));
  els.cancelBackupBtn.addEventListener("click", () => closeSheet(els.backupOverlay));

  // ---- Export ----------------------------------------------------------
  const buildBackupPayload = () => ({
    backupFormat: BACKUP_FORMAT,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    currentMonth: state.currentMonth,
    months: state.months,
    settings: {}, // reserved for future app settings
  });

  const exportBackup = () => {
    try {
      const payload = buildBackupPayload();
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ExpenseTracker-Backup-${todayISODate()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast("Backup exported");
    } catch (err) {
      console.error(err);
      showToast("Could not export backup");
    }
  };

  els.exportBackupBtn.addEventListener("click", () => {
    closeSheet(els.backupOverlay);
    exportBackup();
  });

  // ---- Import ------------------------------------------------------------

  // Validates the parsed JSON has everything required to safely restore.
  // Kept intentionally lenient about *extra* fields (future-compatible)
  // but strict about the shape of what it actually reads.
  const validateBackupData = (data) => {
    if (!data || typeof data !== "object") return false;
    if (!data.months || typeof data.months !== "object" || Array.isArray(data.months)) return false;

    const monthKeys = Object.keys(data.months);
    if (monthKeys.length === 0) return false;

    for (const key of monthKeys) {
      const month = data.months[key];
      if (!month || typeof month !== "object") return false;
      if (!Array.isArray(month.expenses)) return false;
      if (month.income !== null && typeof month.income !== "number") return false;
      for (const exp of month.expenses) {
        if (!exp || typeof exp !== "object") return false;
        if (typeof exp.id !== "string") return false;
        if (typeof exp.name !== "string") return false;
        if (typeof exp.amount !== "number") return false;
        if (exp.type !== "recurring" && exp.type !== "onetime") return false;
      }
    }

    if (data.currentMonth !== undefined && typeof data.currentMonth !== "string") return false;

    return true;
  };

  let pendingImportData = null;

  els.importBackupBtn.addEventListener("click", () => {
    closeSheet(els.backupOverlay);
    els.importFileInput.value = "";
    els.importFileInput.click();
  });

  els.importFileInput.addEventListener("change", () => {
    const file = els.importFileInput.files && els.importFileInput.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      let parsed;
      try {
        parsed = JSON.parse(String(reader.result));
      } catch (err) {
        showToast("Invalid backup file.");
        return;
      }

      if (!validateBackupData(parsed)) {
        showToast("Invalid backup file.");
        return;
      }

      pendingImportData = parsed;
      openSheet(els.importConfirmOverlay);
    };
    reader.onerror = () => {
      showToast("Invalid backup file.");
    };

    try {
      reader.readAsText(file);
    } catch (err) {
      console.error(err);
      showToast("Invalid backup file.");
    }
  });

  els.cancelImportBtn.addEventListener("click", () => {
    pendingImportData = null;
    closeSheet(els.importConfirmOverlay);
  });

  els.confirmImportBtn.addEventListener("click", () => {
    if (!pendingImportData) {
      closeSheet(els.importConfirmOverlay);
      return;
    }

    const monthKeys = Object.keys(pendingImportData.months);
    const restoredCurrentMonth =
      typeof pendingImportData.currentMonth === "string" &&
      pendingImportData.months[pendingImportData.currentMonth]
        ? pendingImportData.currentMonth
        : monthKeys.sort()[monthKeys.length - 1];

    const restoredData = {
      currentMonth: restoredCurrentMonth,
      months: pendingImportData.months,
    };

    const writeOk = writeJSON(DATA_KEY, restoredData);
    if (!writeOk) {
      pendingImportData = null;
      closeSheet(els.importConfirmOverlay);
      showToast("Could not import backup");
      return;
    }

    closeSheet(els.importConfirmOverlay);
    // Reload so every part of the app (state, DOM, quote rotator, etc.)
    // re-initializes cleanly from the freshly restored data.
    window.location.reload();
  });

  /* ---------------------------------------------------------
     First launch check
     (only prompts when the SELECTED month has no income set —
     migrated users already have income and are never prompted)
     --------------------------------------------------------- */
  const init = () => {
    renderAll();
    initQuoteRotator();
    const monthData = getCurrentMonthData();
    if (monthData.income === null || monthData.income === undefined) {
      openIncomeModal(true);
    }
  };

  init();

  /* ---------------------------------------------------------
     Service worker registration (PWA / offline)
     --------------------------------------------------------- */
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("service-worker.js").catch((err) => {
        console.warn("Service worker registration failed:", err);
      });
    });
  }
})();
