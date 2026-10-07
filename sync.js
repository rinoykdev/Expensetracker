/* =========================================================
   Expense Tracker — Cloud Sync (Supabase, no library)

   Local-first: the UI only ever reads and writes localStorage.
   Every change is queued and mirrored to Supabase in the background,
   so the app is instant and works fully offline. The server is a mirror.

   Pieces:
     • Store      — createStore(): put / remove / commit / start /
                    onChange / replaceLocal (+ auth + sync controls)
     • Auth       — three REST endpoints, tokens kept in localStorage,
                    auto-refresh, one retry on 401
     • Write queue— one pending write per row, drained one batch at a
                    time, removed only after the server confirms
     • Sync cycle — push (flush the queue), THEN pull and replace local
   ========================================================= */
(function (global) {
  "use strict";

  /* ---------------------------------------------------------
     CONFIG — paste your Supabase project values here.
     Both are safe to be public (security comes from RLS).
       SUPABASE_URL: https://xxxxxxxx.supabase.co
       SUPABASE_KEY: publishable / anon key (NEVER the service_role key)
     --------------------------------------------------------- */
  const SUPABASE_URL = "https://zbibwiudacafoxdoxlqh.supabase.co";
  const SUPABASE_KEY = "sb_publishable_I3z7Pkg66qVySHxqPlnJYg_zn0svJhV";

  const KEYS = {
    session: "expenseTracker.auth",
    queue: "expenseTracker.sync.queue",
    owner: "expenseTracker.sync.queueOwner",
    meta: "expenseTracker.sync.meta",
    preSync: "expenseTracker.sync.preSyncBackup",
  };

  const PAGE_SIZE = 1000; // PostgREST returns at most 1000 rows per request
  const BATCH_SIZE = 50; // expense upserts sent per request
  const TIMEOUT_MS = 20000;
  const REFRESH_MARGIN_MS = 60 * 1000;
  const DEBOUNCE_MS = 1000;

  /* =========================================================
     Pure helpers (no I/O) — exported for testing
     ========================================================= */

  // JSON.stringify with sorted keys, so two equal objects always compare equal.
  const stable = (v) => {
    if (v === undefined) return "null";
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
    const keys = Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
  };

  // App snapshot ({ months: { "YYYY-MM": { income, expenses[] } } }) -> server rows.
  // Month rows carry the display order of their expenses in data.order.
  const buildRows = (snapshot) => {
    const months = {};
    const expenses = {};
    const src = (snapshot && snapshot.months) || {};
    for (const mk of Object.keys(src)) {
      const m = src[mk] || {};
      const list = Array.isArray(m.expenses) ? m.expenses : [];
      const extra = {};
      for (const k of Object.keys(m)) {
        if (k !== "income" && k !== "expenses") extra[k] = m[k];
      }
      months[mk] = {
        month_key: mk,
        income: m.income === undefined ? null : m.income,
        data: Object.assign({}, extra, { order: list.map((e) => e.id) }),
      };
      for (const e of list) {
        expenses[mk + "|" + e.id] = { month_key: mk, id: e.id, data: e };
      }
    }
    return { months, expenses };
  };

  // Signature map used to detect what changed between two commits.
  const computeSigs = (rows) => {
    const sigs = {};
    for (const mk of Object.keys(rows.months)) {
      const r = rows.months[mk];
      sigs["m:" + mk] = stable({ income: r.income, data: r.data });
    }
    for (const ek of Object.keys(rows.expenses)) {
      sigs["e:" + ek] = stable(rows.expenses[ek].data);
    }
    return sigs;
  };

  // Server rows -> app months object (order restored from data.order).
  const rowsToMonths = (remote) => {
    const out = {};
    const orders = {};
    for (const r of remote.months || []) {
      const data = r.data && typeof r.data === "object" ? r.data : {};
      const extra = Object.assign({}, data);
      delete extra.order;
      orders[r.month_key] = Array.isArray(data.order) ? data.order : [];
      out[r.month_key] = Object.assign(
        { income: r.income === null || r.income === undefined ? null : Number(r.income) },
        extra,
        { expenses: [] }
      );
    }
    for (const r of remote.expenses || []) {
      if (!out[r.month_key]) {
        out[r.month_key] = { income: null, expenses: [] };
        orders[r.month_key] = [];
      }
      out[r.month_key].expenses.push(r.data);
    }
    for (const mk of Object.keys(out)) {
      const pos = new Map(orders[mk].map((id, i) => [id, i]));
      out[mk].expenses.sort((a, b) => {
        const pa = pos.has(a.id) ? pos.get(a.id) : -1;
        const pb = pos.has(b.id) ? pos.get(b.id) : -1;
        if (pa === -1 && pb === -1) return a.id < b.id ? 1 : a.id > b.id ? -1 : 0; // newest first
        if (pa === -1) return -1; // unknown (added elsewhere) goes on top
        if (pb === -1) return 1;
        return pa - pb;
      });
    }
    return out;
  };

  const monthIsEmpty = (m) =>
    !m ||
    ((m.income === null || m.income === undefined) &&
      (!m.expenses || m.expenses.length === 0) &&
      Object.keys(m).every((k) => k === "income" || k === "expenses"));

  // Comparable form of a months object, ignoring empty placeholder months.
  const normalizeMonths = (months) => {
    const out = {};
    for (const mk of Object.keys(months || {})) {
      if (!monthIsEmpty(months[mk])) out[mk] = months[mk];
    }
    return stable(out);
  };

  const hasLocalData = (months) =>
    Object.keys(months || {}).some((mk) => !monthIsEmpty(months[mk]));

  /* =========================================================
     Store factory
     ========================================================= */
  function createStore(opts) {
    const cfg = opts.config || { url: SUPABASE_URL, key: SUPABASE_KEY };
    const configured = !!(cfg.url && cfg.key);
    const storage = opts.storage || global.localStorage;
    const doFetch = opts.fetch || ((...a) => global.fetch(...a));
    const win = opts.window || global;
    const now = opts.now || (() => Date.now());

    /* ---------- tiny storage helpers ---------- */
    const read = (key, fallback) => {
      try {
        const raw = storage.getItem(key);
        return raw === null || raw === undefined ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    };
    const write = (key, value) => {
      try {
        storage.setItem(key, JSON.stringify(value));
        return true;
      } catch (e) {
        return false;
      }
    };

    /* ---------- state ---------- */
    let session = read(KEYS.session, null);
    if (!session || !session.access_token || !session.refresh_token) session = null;

    const meta = read(KEYS.meta, {}) || {};
    let shadow = computeSigs(buildRows(opts.getSnapshot()));
    let writeSeq = 0;
    let running = null;
    let rerun = false;
    let forceFull = false;
    let started = false;
    let timer = null;
    let lastRunEnd = 0;
    let lastAt = 0;
    let refreshing = null;

    let status = {
      state: !configured ? "unconfigured" : session ? "syncing" : "signedOut",
      message: "",
      email: session && session.user ? session.user.email || "" : "",
      lastSyncAt: meta.lastSyncAt || 0,
    };
    const statusListeners = [];
    const changeListeners = [];

    const emitStatus = (patch) => {
      status = Object.assign({}, status, patch);
      statusListeners.forEach((fn) => {
        try {
          fn(status);
        } catch (e) {
          console.warn(e);
        }
      });
    };

    const isSignedIn = () => !!session;
    const queueOwner = () => storage.getItem(KEYS.owner) || null;

    /* ---------- errors ---------- */
    const netError = () =>
      Object.assign(new Error("No connection"), { network: true });
    const authError = (msg) =>
      Object.assign(new Error(msg || "Session expired — please sign in again"), { auth: true });

    const failure = async (res) => {
      let body = null;
      try {
        body = await res.json();
      } catch (e) {
        /* not JSON */
      }
      const msg =
        (body && (body.msg || body.message || body.error_description || body.error)) ||
        "Request failed (" + res.status + ")";
      const err = new Error(msg);
      err.status = res.status;
      err.code = body && (body.error_code || body.code);
      return err;
    };

    const friendly = (err) => {
      if (err.network) return "No connection";
      const m = String(err.message || "");
      if (err.code === "invalid_credentials" || /invalid login credentials/i.test(m))
        return "Wrong email or password";
      if (err.code === "user_already_exists" || /already registered/i.test(m))
        return "An account with this email already exists — use Sign in";
      if (err.code === "weak_password" || /password should be/i.test(m))
        return "Password is too weak (use at least 6 characters)";
      if (err.code === "email_not_confirmed" || /email not confirmed/i.test(m))
        return "Please confirm your email first, then sign in";
      if (err.code === "over_request_rate_limit" || err.status === 429)
        return "Too many attempts — wait a minute and try again";
      if (err.status === 404 || err.code === "PGRST205" || err.code === "42P01")
        return "Database tables are missing — run the SQL setup in Supabase";
      return m || "Something went wrong";
    };

    /* ---------- HTTP ---------- */
    const apiUrl = (path) => String(cfg.url).replace(/\/+$/, "") + path;

    const rawFetch = async (path, init) => {
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const t = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
      try {
        return await doFetch(
          apiUrl(path),
          Object.assign({}, init, ctrl ? { signal: ctrl.signal } : {})
        );
      } catch (e) {
        throw netError();
      } finally {
        if (t) clearTimeout(t);
      }
    };

    const authRequest = async (path, payload) => {
      const res = await rawFetch(path, {
        method: "POST",
        headers: { apikey: cfg.key, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw await failure(res);
      return res.json();
    };

    const sessionFrom = (data) => ({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at
        ? data.expires_at * 1000
        : now() + (data.expires_in || 3600) * 1000,
      user: {
        id: data.user && data.user.id,
        email: data.user && data.user.email,
      },
    });

    const clearSession = () => {
      session = null;
      try {
        storage.removeItem(KEYS.session);
      } catch (e) {
        /* ignore */
      }
    };

    const refreshSession = () => {
      if (refreshing) return refreshing;
      refreshing = (async () => {
        try {
          if (!session) throw authError();
          const res = await rawFetch("/auth/v1/token?grant_type=refresh_token", {
            method: "POST",
            headers: { apikey: cfg.key, "Content-Type": "application/json" },
            body: JSON.stringify({ refresh_token: session.refresh_token }),
          });
          if (res.ok) {
            const data = await res.json();
            const next = sessionFrom(data);
            if (!next.user.id && session.user) next.user = session.user;
            session = next;
            write(KEYS.session, session);
            return;
          }
          if (res.status >= 400 && res.status < 500) {
            // The refresh token is dead — drop the session, keep ALL local data.
            clearSession();
            throw authError();
          }
          throw await failure(res);
        } finally {
          refreshing = null;
        }
      })();
      return refreshing;
    };

    // Every data call goes through here: refresh if near expiry,
    // retry once on 401, then give up and clear the session.
    const authedFetch = async (path, init) => {
      if (!session) throw authError();
      if (session.expires_at - now() < REFRESH_MARGIN_MS) await refreshSession();
      const withAuth = () =>
        Object.assign({}, init, {
          headers: Object.assign({}, init.headers, {
            apikey: cfg.key,
            Authorization: "Bearer " + session.access_token,
          }),
        });
      let res = await rawFetch(path, withAuth());
      if (res.status === 401) {
        await refreshSession();
        res = await rawFetch(path, withAuth());
        if (res.status === 401) {
          clearSession();
          throw authError();
        }
      }
      return res;
    };

    /* ---------- write queue ---------- */
    const loadQueue = () => {
      const q = read(KEYS.queue, []);
      return Array.isArray(q) ? q : [];
    };
    const saveQueue = (q) => {
      if (!write(KEYS.queue, q)) forceFull = true; // couldn't persist — re-push everything next time
    };
    const stamp = () => {
      lastAt = Math.max(now(), lastAt + 1);
      return lastAt;
    };

    // Only ONE pending write per row: a newer change replaces the older one.
    const enqueue = (item) => {
      if (!queueOwner()) return; // never signed in on this device — nothing to mirror yet
      item.at = stamp();
      const q = loadQueue().filter((x) => !(x.table === item.table && x.key === item.key));
      q.push(item);
      saveQueue(q);
    };

    const put = (table, key, row) => enqueue({ op: "put", table, key, row });
    const remove = (table, key, ref) => enqueue({ op: "del", table, key, ref });

    const removeFromQueue = (done) => {
      const q = loadQueue().filter(
        (x) => !done.some((d) => d.table === x.table && d.key === x.key && d.at === x.at)
      );
      saveQueue(q);
    };

    /* ---------- commit: diff current data against what we last saw ---------- */
    const commit = (snapshot) => {
      const rows = buildRows(snapshot || opts.getSnapshot());
      const next = computeSigs(rows);
      let changed = false;

      for (const k of Object.keys(next)) {
        if (shadow[k] === next[k]) continue;
        changed = true;
        if (k.startsWith("m:")) {
          put("months", k.slice(2), rows.months[k.slice(2)]);
        } else {
          put("expenses", k.slice(2), rows.expenses[k.slice(2)]);
        }
      }
      for (const k of Object.keys(shadow)) {
        if (k in next) continue;
        changed = true;
        if (k.startsWith("m:")) {
          remove("months", k.slice(2), { month_key: k.slice(2) });
        } else {
          const ek = k.slice(2);
          const i = ek.indexOf("|");
          remove("expenses", ek, { month_key: ek.slice(0, i), id: ek.slice(i + 1) });
        }
      }

      shadow = next;
      if (changed) {
        writeSeq++;
        if (isSignedIn()) schedule(DEBOUNCE_MS);
      }
      return changed;
    };

    // Queue EVERYTHING that exists locally (first sign-in / re-seed).
    // Placeholder months are skipped, and a month whose income was never
    // set omits `income`, so it can never blank a value already on the server.
    const fullPush = () => {
      const rows = buildRows(opts.getSnapshot());
      for (const mk of Object.keys(rows.months)) {
        const r = rows.months[mk];
        const hasExpenses = r.data.order.length > 0;
        const hasExtras = Object.keys(r.data).some((k) => k !== "order");
        if (r.income === null && !hasExpenses && !hasExtras) continue;
        put(
          "months",
          mk,
          r.income === null ? { month_key: r.month_key, data: r.data } : r
        );
      }
      for (const ek of Object.keys(rows.expenses)) put("expenses", ek, rows.expenses[ek]);
    };

    /* ---------- flush (push) ---------- */
    const sendBatch = async (batch) => {
      const uidv = session && session.user && session.user.id;
      if (!uidv) throw authError();
      const first = batch[0];
      const enc = encodeURIComponent;
      let res;

      if (first.op === "put") {
        const rows = batch.map((b) => Object.assign({ user_id: uidv }, b.row));
        const conflict =
          first.table === "months" ? "user_id,month_key" : "user_id,month_key,id";
        res = await authedFetch(
          "/rest/v1/" + first.table + "?on_conflict=" + conflict,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Prefer: "resolution=merge-duplicates,return=minimal",
            },
            body: JSON.stringify(first.table === "months" ? rows[0] : rows),
          }
        );
      } else if (first.table === "months") {
        res = await authedFetch(
          "/rest/v1/months?user_id=eq." + enc(uidv) + "&month_key=eq." + enc(first.ref.month_key),
          { method: "DELETE", headers: { Prefer: "return=minimal" } }
        );
      } else {
        res = await authedFetch(
          "/rest/v1/expenses?user_id=eq." + enc(uidv) +
            "&month_key=eq." + enc(first.ref.month_key) +
            "&id=eq." + enc(first.ref.id),
          { method: "DELETE", headers: { Prefer: "return=minimal" } }
        );
      }
      if (!res.ok) throw await failure(res);
    };

    const flush = async () => {
      for (;;) {
        const q = loadQueue();
        if (!q.length) return;
        const first = q[0];
        const batch = [first];
        if (first.op === "put" && first.table === "expenses") {
          for (let i = 1; i < q.length && batch.length < BATCH_SIZE; i++) {
            if (q[i].op === "put" && q[i].table === "expenses") batch.push(q[i]);
            else break;
          }
        }
        await sendBatch(batch);
        removeFromQueue(batch); // only after the server confirmed
      }
    };

    /* ---------- pull ---------- */
    const fetchAll = async (table, order) => {
      const all = [];
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const res = await authedFetch(
          "/rest/v1/" + table + "?select=*&order=" + order +
            "&limit=" + PAGE_SIZE + "&offset=" + offset,
          { method: "GET", headers: {} }
        );
        if (!res.ok) throw await failure(res);
        const rows = await res.json();
        all.push(...rows);
        if (rows.length < PAGE_SIZE) break;
      }
      return all;
    };

    const pullAll = async () => ({
      months: await fetchAll("months", "month_key.asc"),
      expenses: await fetchAll("expenses", "month_key.asc,id.asc"),
    });

    // Overwrite the local cache with server data (this is what lets
    // deletions made on another device propagate).
    const replaceLocal = (months) => {
      opts.applySnapshot({ months });
      shadow = computeSigs(buildRows(opts.getSnapshot()));
      changeListeners.forEach((fn) => {
        try {
          fn();
        } catch (e) {
          console.warn(e);
        }
      });
    };

    /* ---------- sync cycle: push, then pull ---------- */
    const backupOnce = () => {
      try {
        if (storage.getItem(KEYS.preSync) === null) {
          write(KEYS.preSync, { savedAt: now(), data: opts.getSnapshot() });
        }
      } catch (e) {
        /* ignore */
      }
    };

    const handleError = (err) => {
      if (err && err.auth) {
        emitStatus({ state: "signedOut", email: "", message: err.message });
      } else if (err && err.network) {
        emitStatus({ state: "offline", message: "" });
      } else {
        console.warn("[sync]", err);
        emitStatus({ state: "error", message: friendly(err || {}) });
      }
    };

    const cycle = async (full) => {
      if (full) {
        backupOnce();
        fullPush();
      } else if (forceFull) {
        forceFull = false;
        fullPush();
      }

      let reseeded = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        await flush();
        const seq = writeSeq;
        const remote = await pullAll();

        // Something changed on this device while we were fetching — go again.
        if (seq !== writeSeq || loadQueue().length) continue;

        const remoteEmpty = remote.months.length === 0 && remote.expenses.length === 0;
        const local = opts.getSnapshot().months;

        // Server has nothing but this device does (e.g. project reset):
        // re-seed the server rather than wiping local data.
        if (remoteEmpty && hasLocalData(local)) {
          if (reseeded) return false;
          reseeded = true;
          fullPush();
          continue;
        }

        const remoteMonths = rowsToMonths(remote);
        if (normalizeMonths(remoteMonths) !== normalizeMonths(local)) {
          replaceLocal(remoteMonths);
        }
        return true;
      }
      return false;
    };

    const runSync = (o) => {
      const full = !!(o && o.full);
      if (!configured || !session) return Promise.resolve();
      if (running) {
        rerun = true;
        if (full) forceFull = true;
        return running;
      }
      if (win.navigator && win.navigator.onLine === false) {
        emitStatus({ state: "offline", message: "" });
        return Promise.resolve();
      }
      emitStatus({ state: "syncing", message: "" });
      running = (async () => {
        try {
          const done = await cycle(full);
          if (done) {
            meta.lastSyncAt = now();
            write(KEYS.meta, meta);
            emitStatus({
              state: "synced",
              message: "",
              lastSyncAt: meta.lastSyncAt,
              email: session && session.user ? session.user.email || "" : "",
            });
          } else {
            rerun = true;
          }
        } catch (err) {
          handleError(err);
        } finally {
          running = null;
          lastRunEnd = now();
          if (rerun) {
            rerun = false;
            schedule(250);
          }
        }
      })();
      return running;
    };

    function schedule(ms) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        runSync();
      }, ms);
    }

    /* ---------- auth actions ---------- */
    const adoptSession = (s) => {
      // A different account on this device? Its queue must not leak across.
      if (queueOwner() !== s.user.id) {
        saveQueue([]);
        try {
          storage.setItem(KEYS.owner, s.user.id);
        } catch (e) {
          /* ignore */
        }
      }
      session = s;
      write(KEYS.session, s);
      emitStatus({ state: "syncing", message: "", email: s.user.email || "" });
      runSync({ full: true }); // first sign-in pushes local data BEFORE the first pull
    };

    const requireConfigured = () => {
      if (!configured) {
        throw new Error("Cloud sync isn't set up yet — add your Supabase URL and key in sync.js");
      }
    };

    const signIn = async (email, password) => {
      try {
        requireConfigured();
        const data = await authRequest("/auth/v1/token?grant_type=password", { email, password });
        adoptSession(sessionFrom(data));
        return { ok: true };
      } catch (err) {
        return { ok: false, error: friendly(err) };
      }
    };

    const signUp = async (email, password) => {
      try {
        requireConfigured();
        const data = await authRequest("/auth/v1/signup", { email, password });
        if (data && data.access_token) {
          adoptSession(sessionFrom(data));
          return { ok: true };
        }
        const u = (data && data.user) || data || {};
        if (Array.isArray(u.identities) && u.identities.length === 0) {
          return { ok: false, error: "An account with this email already exists — use Sign in" };
        }
        // Email confirmation is ON in Supabase: account exists but has no session yet.
        return { ok: true, needsConfirmation: true };
      } catch (err) {
        return { ok: false, error: friendly(err) };
      }
    };

    // Signing out is NOT destructive: local data stays exactly as it is.
    const signOut = async () => {
      const s = session;
      clearSession();
      if (timer) clearTimeout(timer);
      emitStatus({ state: "signedOut", email: "", message: "" });
      if (s) {
        try {
          await rawFetch("/auth/v1/logout", {
            method: "POST",
            headers: { apikey: cfg.key, Authorization: "Bearer " + s.access_token },
          });
        } catch (e) {
          /* best effort */
        }
      }
    };

    /* ---------- triggers ---------- */
    const start = () => {
      if (started) return;
      started = true;
      if (win.addEventListener) win.addEventListener("online", () => schedule(0));
      const doc = win.document;
      if (doc && doc.addEventListener) {
        doc.addEventListener("visibilitychange", () => {
          if (doc.visibilityState === "visible" && now() - lastRunEnd > 3000) schedule(0);
        });
      }
      if (session) schedule(0); // on launch
    };

    return {
      // ----- storage interface -----
      put,
      remove,
      commit,
      replaceLocal,
      start,
      onChange: (fn) => changeListeners.push(fn),
      // ----- sync + auth controls -----
      signIn,
      signUp,
      signOut,
      syncNow: () => runSync(),
      onStatus: (fn) => {
        statusListeners.push(fn);
        fn(status);
      },
      getStatus: () => status,
      // What the user perceives as "changes": expense rows, plus month rows that
      // changed on their own (e.g. income). A month's order-list bookkeeping that
      // rides along with an expense change is not counted separately.
      pendingCount: () => {
        const q = loadQueue();
        const monthsWithExpenseOps = new Set(
          q.filter((x) => x.table === "expenses").map((x) => (x.row || x.ref).month_key)
        );
        return q.filter((x) => x.table === "expenses" || !monthsWithExpenseOps.has(x.key)).length;
      },
      isConfigured: () => configured,
      isSignedIn,
    };
  }

  global.ExpenseSync = {
    createStore,
    _internals: { stable, buildRows, computeSigs, rowsToMonths, normalizeMonths, hasLocalData },
  };
})(typeof window !== "undefined" ? window : globalThis);
