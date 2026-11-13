// Crafty Crew reports admin (craftycrew.app/admin/). Everything it does goes through the admin_* functions of migration
// 0030_moderation: each one checks on the server that the signed-in account is in public.admins ("not allowed"
// otherwise) and writes the action log. This page holds no secret: only the project's publishable key.
//
// ---- Project ---------------------------------------------------------------------------------------------------------
// While testing: ACTIVE = "test". AT GO-LIVE: set ACTIVE = "live" (after 0030 is on LIVE, the admin row is added and
// https://craftycrew.app/admin/ is in LIVE's Auth redirect URLs). Publishable keys only - never a secret / service key.
const PROJECTS = {
  test: { name: "TEST", url: "https://lifozzjxwtljwvwuswic.supabase.co", key: "sb_publishable_O4cIMnKqjmQJuLyTpSKTow_caOOm4Nc" },
  live: { name: "LIVE", url: "https://hjxpswtcnxcvssyhlalc.supabase.co", key: "sb_publishable_ddmqh0CXt9p4Luyt6XOoKA_avNz-E9N" },
};
const ACTIVE = "test";
// -----------------------------------------------------------------------------------------------------------------------

const P = PROJECTS[ACTIVE];
const PAGE = 30;
const REASONS = { offensive_name: "Offensive name", cheating: "Cheating", harassment: "Harassment", other: "Other" };
const db = window.supabase.createClient(P.url, P.key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "cc-admin-" + ACTIVE },
});

const $ = (id) => document.getElementById(id);
const SECTIONS = ["login", "denied", "reports", "player", "log"];
let reportStatus = "open";
let reportsBefore = null;
let logBefore = null;
let currentPlayer = null; // { id, report }

// ---- DOM helpers (text only: player names are typed by players, never put in as HTML) ----------------------------------
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid instanceof Node ? kid : String(kid));
  return e;
}
function when(t) {
  if (!t) return "-";
  const d = new Date(t);
  return isNaN(d) ? String(t) : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
function show(id) {
  for (const s of SECTIONS) $(s).hidden = s !== id;
  for (const a of document.querySelectorAll("[data-nav]")) a.classList.toggle("on", a.dataset.nav === id || (id === "player" && a.dataset.nav === "reports"));
}
function say(text, error = false) {
  $("status").textContent = text || "";
  $("status").classList.toggle("error", !!error);
}
function errText(e) {
  return (e && (e.message || e.error_description || e.msg)) || String(e);
}

// Calls an admin function. "not allowed" (not an admin) shows the NOT ALLOWED screen.
async function rpc(name, args) {
  const { data, error } = await db.rpc(name, args || {});
  if (error) {
    if (/not allowed/i.test(error.message || "")) {
      denied("This account isn't an admin (the server said “not allowed”).");
    }
    throw error;
  }
  return data;
}
function denied(msg) {
  $("denied-msg").textContent = msg;
  $("nav").hidden = true;
  say("");
  show("denied");
}

// ---- Confirm dialog ---------------------------------------------------------------------------------------------------
// fields: [{ id, label, type: "number" | "select" | "textarea", value, options, min, max, required }]
function confirmBox(title, text, fields = [], danger = false) {
  return new Promise((resolve) => {
    const dlg = $("confirm");
    $("confirm-title").textContent = title;
    $("confirm-text").textContent = text;
    const box = $("confirm-fields");
    box.replaceChildren();
    const inputs = {};
    for (const f of fields) {
      let input;
      if (f.type === "select") {
        input = el("select", { id: "f-" + f.id }, ...Object.entries(f.options).map(([v, t]) => el("option", { value: v, text: t, selected: v === f.value })));
      } else if (f.type === "textarea") {
        input = el("textarea", { id: "f-" + f.id, maxlength: 500 });
        input.value = f.value || "";
      } else {
        input = el("input", { id: "f-" + f.id, type: f.type || "text", inputmode: f.type === "number" ? "numeric" : null, min: f.min, max: f.max, required: f.required });
        input.value = f.value ?? "";
      }
      inputs[f.id] = input;
      box.append(el("label", { for: "f-" + f.id, text: f.label }), input);
    }
    $("confirm-ok").className = danger ? "danger" : "primary";
    const done = () => {
      dlg.removeEventListener("close", done);
      if (dlg.returnValue !== "ok") return resolve(null);
      const out = {};
      for (const [k, i] of Object.entries(inputs)) out[k] = i.value;
      resolve(out);
    };
    dlg.addEventListener("close", done);
    dlg.returnValue = "";
    dlg.showModal();
  });
}

// Runs one action after the confirm: says what happened, then reloads what's on screen.
async function act(title, text, fields, run, danger = false) {
  const values = await confirmBox(title, text, fields, danger);
  if (!values) return;
  say("Working…");
  let result;
  try {
    await run(values);
    result = [title + ": done.", false];
  } catch (e) {
    result = [title + " failed: " + errText(e), true];
  }
  if (currentPlayer && location.hash.startsWith("#player/")) await loadPlayer(currentPlayer.id, currentPlayer.report);
  else if (location.hash.startsWith("#reports") || location.hash === "") await loadReports(true);
  say(...result);
}

// ---- Login ------------------------------------------------------------------------------------------------------------
let loginEmail = "";
$("email-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  loginEmail = $("email").value.trim();
  say("Sending a code…");
  const { error } = await db.auth.signInWithOtp({
    email: loginEmail,
    options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname },
  });
  if (error) {
    // shouldCreateUser false: an email with no account gets "Signups not allowed for otp" (no account is made).
    return say(/signups not allowed/i.test(errText(error)) ? "No account with that email." : "Couldn't send a code: " + errText(error), true);
  }
  $("email-form").hidden = true;
  $("code-form").hidden = false;
  $("code").focus();
  say("If that email has an account, a code is on its way.");
});
$("code-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  say("Checking…");
  const { error } = await db.auth.verifyOtp({ email: loginEmail, token: $("code").value.trim(), type: "email" });
  if (error) return say("That code didn't work: " + errText(error), true);
  $("code").value = "";
  say("");
  await route();
});
$("code-back").addEventListener("click", () => {
  $("code-form").hidden = true;
  $("email-form").hidden = false;
  say("");
});
async function signOut() {
  await db.auth.signOut();
  $("nav").hidden = true;
  $("email-form").hidden = false;
  $("code-form").hidden = true;
  say("Signed out.");
  show("login");
}
$("signout").addEventListener("click", signOut);
$("denied-signout").addEventListener("click", signOut);

// ---- Reports ----------------------------------------------------------------------------------------------------------
for (const b of document.querySelectorAll("#status-tabs button")) {
  b.addEventListener("click", () => {
    reportStatus = b.dataset.status;
    loadReports(true);
  });
}
$("reports-refresh").addEventListener("click", () => loadReports(true));
$("reports-more").addEventListener("click", () => loadReports(false));

async function loadReports(fresh) {
  if (fresh) reportsBefore = null;
  for (const b of document.querySelectorAll("#status-tabs button")) {
    const on = b.dataset.status === reportStatus;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  }
  say("Loading…");
  let rows;
  try {
    rows = await rpc("admin_reports", { p_status: reportStatus, p_limit: PAGE, p_before: reportsBefore });
  } catch (e) {
    if (!$("denied").hidden) return;
    return say("Couldn't load reports: " + errText(e), true);
  }
  const list = $("reports-list");
  if (fresh) list.replaceChildren();
  for (const r of rows) list.append(reportCard(r));
  if (fresh && rows.length === 0) list.append(el("p", { class: "muted", text: "No " + (reportStatus === "all" ? "" : reportStatus + " ") + "reports." }));
  reportsBefore = rows.length ? rows[rows.length - 1].id : reportsBefore;
  $("reports-more").hidden = rows.length < PAGE;
  say("");
}

function reportCard(r) {
  const deleted = !r.reported;
  const nameNow = deleted ? "(account deleted)" : (r.reported_current_name || "?");
  const renamed = !deleted && r.reported_current_name && r.reported_current_name !== r.reported_name;
  const setStatus = (s) => act("Mark report " + s, "Report #" + r.id + " about " + r.reported_name + " becomes " + s + ".", [],
    () => rpc("admin_set_report_status", { p_report: r.id, p_status: s }));
  return el("article", { class: "card" },
    el("div", { class: "row between" },
      el("span", { class: "name", text: r.reported_name || nameNow }),
      el("span", {}, el("span", { class: "chip" + (r.status === "open" ? " warn" : ""), text: r.status }),
        r.reported_banned ? el("span", { class: "chip bad", text: "banned" }) : null)),
    renamed ? el("div", { class: "meta", text: "now: " + nameNow + (r.reported_username ? " (@" + r.reported_username + ")" : "") }) : null,
    deleted ? el("div", { class: "meta", text: "account deleted " + when(r.reported_deleted_at) }) : null,
    el("div", {}, el("span", { class: "chip", text: REASONS[r.reason] || r.reason }), r.context ? el("span", { class: "chip", text: "in " + r.context }) : null,
      el("span", { class: "chip", text: r.reports_on_player + " report" + (r.reports_on_player == 1 ? "" : "s") + " (" + r.open_reports_on_player + " open)" })),
    el("div", { class: "meta", text: "#" + r.id + " · " + when(r.created_at) + " · by " + (r.reporter_name || "(deleted or unknown)") +
      (r.reporter ? " (" + r.reports_by_reporter + " sent)" : "") }),
    el("div", { class: "actions" },
      deleted ? null : el("button", { type: "button", class: "small primary", text: "Open player", onclick: () => { location.hash = "#player/" + r.reported + "?report=" + r.id; } }),
      r.status !== "reviewed" ? el("button", { type: "button", class: "small", text: "Mark reviewed", onclick: () => setStatus("reviewed") }) : null,
      r.status !== "actioned" ? el("button", { type: "button", class: "small", text: "Mark actioned", onclick: () => setStatus("actioned") }) : null,
      r.status !== "open" ? el("button", { type: "button", class: "small", text: "Reopen", onclick: () => setStatus("open") }) : null));
}

// ---- Player -----------------------------------------------------------------------------------------------------------
$("player-back").addEventListener("click", () => history.length > 1 ? history.back() : (location.hash = "#reports"));

async function loadPlayer(id, report) {
  currentPlayer = { id, report };
  say("Loading…");
  let j;
  try {
    j = await rpc("admin_player", { p_user: id });
  } catch (e) {
    if (!$("denied").hidden) return;
    $("player-body").replaceChildren();
    return say("Couldn't load the player: " + errText(e), true);
  }
  say("");
  const p = j.profile;
  const ban = j.active_ban;
  const lock = j.name_lock && j.name_lock.active ? j.name_lock : null;
  const name = p.display_name;
  const rep = report ? Number(report) : null;
  const repNote = rep ? " Report #" + rep + " is marked actioned." : "";
  const reasonField = { id: "reason", label: "Reason", type: "select", options: REASONS, value: "offensive_name" };
  const noteField = { id: "note", label: "Note (only admins see it)", type: "textarea" };

  const actions = el("div", { class: "grid-actions" },
    el("button", { type: "button", text: "Reset name", onclick: () => act("Reset name",
      name + " becomes PlayerNNNN" + (p.username ? " and @" + p.username + " becomes player_NNNNNN" : "") + ". The old names are kept." + repNote, [],
      () => rpc("admin_reset_name", { p_user: id, p_report: rep })) }),
    el("button", { type: "button", text: "Lock name", onclick: () => act("Lock name",
      name + " can't change their name or username. Leave hours empty to lock for good.", [{ id: "hours", label: "Hours (empty = for good)", type: "number", min: 1, max: 87600, value: "72" }],
      (v) => rpc("admin_lock_name", { p_user: id, p_hours: v.hours === "" ? null : parseInt(v.hours, 10) })) }),
    lock ? el("button", { type: "button", text: "Unlock name", onclick: () => act("Unlock name", name + " can rename again.", [],
      () => rpc("admin_lock_name", { p_user: id, p_hours: 0 })) }) : null,
    el("button", { type: "button", class: "danger", text: "Temp ban", onclick: () => act("Temp ban",
      name + " can't play online, add friends, invite, report or rename until it ends." + (ban ? " It replaces the current ban." : "") + repNote,
      [{ id: "hours", label: "Hours", type: "number", min: 1, max: 87600, value: "24", required: true }, reasonField, noteField],
      (v) => rpc("admin_ban", { p_user: id, p_kind: "temp", p_hours: parseInt(v.hours, 10), p_reason: v.reason, p_note: v.note, p_report: rep }), true) }),
    el("button", { type: "button", class: "danger", text: "Perm ban", onclick: () => act("Permanent ban",
      name + " is banned until an admin lifts it." + (ban ? " It replaces the current ban." : "") + repNote, [reasonField, noteField],
      (v) => rpc("admin_ban", { p_user: id, p_kind: "perm", p_hours: null, p_reason: v.reason, p_note: v.note, p_report: rep }), true) }),
    ban ? el("button", { type: "button", text: "Unban", onclick: () => act("Unban", "Lift " + name + "'s ban now.", [],
      () => rpc("admin_unban", { p_user: id })) }) : null,
    rep ? el("button", { type: "button", text: "Mark report reviewed", onclick: () => act("Mark report reviewed", "Report #" + rep + " becomes reviewed (no action).", [],
      () => rpc("admin_set_report_status", { p_report: rep, p_status: "reviewed" })) }) : null);

  const banLine = ban
    ? el("span", { class: "chip bad", text: ban.permanent ? "banned for good" : "banned until " + when(ban.until) })
    : el("span", { class: "chip good", text: "not banned" });
  const lockLine = lock ? el("span", { class: "chip warn", text: lock.permanent ? "name locked for good" : "name locked until " + when(lock.until) }) : null;

  $("player-body").replaceChildren(
    el("h1", { text: name }),
    el("div", {}, banLine, lockLine, p.guest ? el("span", { class: "chip", text: "guest" }) : null),
    el("h2", { text: "Profile" }),
    el("dl", { class: "kv" },
      el("dt", { text: "Username" }), el("dd", { text: p.username ? "@" + p.username : "-" }),
      el("dt", { text: "Friend code" }), el("dd", { text: p.friend_code ? "CC-" + p.friend_code : "-" }),
      el("dt", { text: "Level" }), el("dd", { text: p.level + " (" + p.xp + " XP)" }),
      el("dt", { text: "Joined" }), el("dd", { text: when(p.created_at) }),
      el("dt", { text: "Last seen" }), el("dd", { text: when(p.last_seen_at) }),
      el("dt", { text: "Signs in with" }), el("dd", { text: (p.providers || []).join(", ") || (p.guest ? "guest" : "-") }),
      el("dt", { text: "Matches" }), el("dd", { text: j.matches.total + " total, " + j.matches.last_7_days + " in 7 days (last " + when(j.matches.last_at) + ")" }),
      el("dt", { text: "Reports" }), el("dd", { text: j.reports_about_count + " about, " + j.reports_by_count + " sent" }),
      el("dt", { text: "Blocked by" }), el("dd", { text: j.blocked_by_count + " player" + (j.blocked_by_count == 1 ? "" : "s") }),
      j.replaced_names ? el("dt", { text: "Earlier name" }) : null,
      j.replaced_names ? el("dd", { text: (j.replaced_names.old_display_name || "-") + (j.replaced_names.old_username ? " (@" + j.replaced_names.old_username + ")" : "") + ", reset " + when(j.replaced_names.replaced_at) }) : null,
      el("dt", { text: "Player id" }), el("dd", { class: "mono", text: p.id })),
    el("h2", { text: "Actions" + (rep ? " (for report #" + rep + ")" : "") }),
    actions,
    el("h2", { text: "Reports about " + name }),
    list(j.reports_about, (r) => el("div", { class: "card" },
      el("div", {}, el("span", { class: "chip", text: REASONS[r.reason] || r.reason }), el("span", { class: "chip" + (r.status === "open" ? " warn" : ""), text: r.status }),
        r.context ? el("span", { class: "chip", text: "in " + r.context }) : null),
      el("div", { class: "meta", text: "#" + r.id + " · " + when(r.created_at) + " · as “" + r.reported_name + "” · by " + (r.reporter_name || "(deleted)") }))),
    el("h2", { text: "Reports sent by " + name }),
    list(j.reports_by, (r) => el("div", { class: "card" },
      el("div", {}, el("span", { class: "chip", text: REASONS[r.reason] || r.reason }), el("span", { class: "chip", text: r.status })),
      el("div", { class: "meta" }, "#" + r.id + " · " + when(r.created_at) + " · about ",
        r.reported ? el("a", { href: "#player/" + r.reported, text: r.reported_name }) : r.reported_name))),
    el("h2", { text: "Bans" }),
    list(j.bans, (b) => el("div", { class: "card" },
      el("div", {}, el("span", { class: "chip" + (b.active ? " bad" : ""), text: b.active ? "active" : (b.lifted_at ? "lifted" : "ended") }),
        el("span", { class: "chip", text: b.kind === "perm" ? "permanent" : "temp" }), el("span", { class: "chip", text: REASONS[b.reason] || b.reason })),
      el("div", { class: "meta", text: when(b.created_at) + (b.kind === "temp" ? " → " + when(b.until) : "") + (b.lifted_at ? " · lifted " + when(b.lifted_at) : "") }),
      b.note ? el("div", { text: "Note: " + b.note }) : null)));
  show("player");
}

function list(rows, card) {
  if (!rows || rows.length === 0) return el("p", { class: "muted", text: "None." });
  return el("div", { class: "list" }, rows.map(card));
}

// ---- Log --------------------------------------------------------------------------------------------------------------
$("log-views").addEventListener("change", () => loadLog(true));
$("log-more").addEventListener("click", () => loadLog(false));

async function loadLog(fresh) {
  if (fresh) logBefore = null;
  say("Loading…");
  let rows;
  try {
    rows = await rpc("admin_log", { p_limit: 100, p_before: logBefore });
  } catch (e) {
    if (!$("denied").hidden) return;
    return say("Couldn't load the log: " + errText(e), true);
  }
  const listEl = $("log-list");
  if (fresh) listEl.replaceChildren();
  const views = $("log-views").checked;
  for (const a of rows) {
    if (!views && a.action.startsWith("view_")) continue;
    const d = { ...a.details };
    listEl.append(el("div", { class: "card" },
      el("div", { class: "row between" }, el("span", { class: "name", text: a.action.replace(/_/g, " ") }), el("span", { class: "meta", text: when(a.at) })),
      el("div", { class: "meta" }, "by " + (a.admin_name || (a.admin_id ? a.admin_id.slice(0, 8) : "(deleted)")),
        a.target_user ? [" · ", el("a", { href: "#player/" + a.target_user, text: a.target_name || a.target_user.slice(0, 8) })] : "",
        a.report_id ? " · report #" + a.report_id : ""),
      Object.keys(d).length ? el("pre", { class: "details mono", text: JSON.stringify(d) }) : null));
  }
  if (fresh && listEl.childElementCount === 0) listEl.append(el("p", { class: "muted", text: "Nothing yet." }));
  logBefore = rows.length ? rows[rows.length - 1].id : logBefore;
  $("log-more").hidden = rows.length < 100;
  say("");
}

// ---- Routing ----------------------------------------------------------------------------------------------------------
async function route() {
  window.scrollTo(0, 0);
  const { data } = await db.auth.getSession();
  if (!data.session) {
    $("nav").hidden = true;
    show("login");
    return;
  }
  $("nav").hidden = false;
  const h = location.hash || "#reports";
  const m = h.match(/^#player\/([0-9a-f-]{36})(?:\?report=(\d+))?$/i);
  if (m) {
    show("player");
    $("player-body").replaceChildren();
    await loadPlayer(m[1], m[2] || null);
  } else if (h === "#log") {
    show("log");
    await loadLog(true);
  } else {
    show("reports");
    await loadReports(true);
  }
}

$("project").textContent = P.name;
$("project").classList.add(ACTIVE);
window.addEventListener("hashchange", route);
db.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_OUT") show("login");
});
route();
