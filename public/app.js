/* Drop Watch front end. Plain JS, no build step. */

const $ = (id) => document.getElementById(id);
const state = { publicKey: "", sub: null, reg: null };

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
const standalone =
  window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

function ago(ts) {
  if (!ts) return "";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function urlB64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function api(path, opts) {
  const res = await fetch(`/api/${path}`, opts);
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
}

function renderFeed(items, watchedCount) {
  const feed = $("feed");
  if (!items.length) {
    // An empty list is the normal state between drops, and saying how many
    // products are being watched is the difference between "nothing new" and
    // "this thing is broken".
    const watched = watchedCount
      ? ` ${watchedCount.toLocaleString()} products are on the watch list.`
      : "";
    feed.innerHTML =
      `<li class="empty">Nothing new since the last check.${watched} This list only shows products that appeared on Pokémon Center after you started watching, so it stays empty until something actually drops.</li>`;
    return;
  }
  feed.innerHTML = items
    .map((i) => {
      const title = i.title || "(untitled)";
      const link = i.url
        ? `<a href="${i.url}" target="_blank" rel="noopener">${escapeHtml(title)}</a>`
        : `<span>${escapeHtml(title)}</span>`;
      const upc = i.upc ? `<span class="chip upc">UPC ${escapeHtml(i.upc)}</span>` : "";
      // The SKU is how a drop is identified on a queue page, so put it where
      // it can be read and copied rather than leaving it buried in the link.
      const sku = i.sku ? `<span class="chip upc">SKU ${escapeHtml(i.sku)}</span>` : "";
      return `<li>${link}<div class="meta"><span class="chip">${escapeHtml(
        i.source,
      )}</span>${sku}${upc}<span class="when">${ago(i.found)}</span></div></li>`;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function loadState() {
  const { ok, body } = await api("state");
  if (!ok) {
    $("status").textContent = "Could not reach the server";
    return;
  }
  state.publicKey = body.publicKey || "";
  renderFeed(body.items || [], body.watchedCount || 0);
  // Say plainly which sources can buzz the phone. The shelf sightings are
  // people posting what they saw, so they belong in the list to read but must
  // never look like something that will wake you up.
  const pushes = body.pushSources || [];
  $("sources").innerHTML = (body.watching || [])
    .map((s) => {
      const alerts = pushes.includes(s);
      const label = escapeHtml(s) + (alerts ? " · alerts you" : "");
      return `<li class="${alerts ? "alerts" : ""}">${label}</li>`;
    })
    .join("");

  // The notes are how you tell a quiet app from a broken one.
  const byKind = body.notesByKind || {};
  const lines = [...(byKind.pc || []), ...(byKind.news || []), ...(byKind.upc || [])];
  const notes = $("notes");
  if (notes) {
    notes.innerHTML = lines.length
      ? lines.map((n) => `<li>${escapeHtml(n)}</li>`).join("")
      : "<li>Nothing reported yet.</li>";
  }

  const last = body.lastPoll;
  const stale = last && Date.now() - last > 20 * 60 * 1000;
  const cls = !last ? "off" : stale ? "stale" : "";
  $("status").innerHTML = last
    ? `<span class="dot ${cls}"></span>Last checked ${ago(last)}`
    : '<span class="dot off"></span>Waiting for the first check';
  refreshAlertUi();
}

function setAlertUi({ message, enable, disable, test }) {
  $("alert-state").textContent = message;
  $("enable").hidden = !enable;
  $("disable").hidden = !disable;
  $("test").hidden = !test;
}

async function refreshAlertUi() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    setAlertUi({ message: "This browser cannot do push notifications." });
    $("ios-hint").hidden = !isIOS;
    return;
  }
  if (isIOS && !standalone) {
    setAlertUi({ message: "Add this to your Home Screen first, then open it from there." });
    $("ios-hint").hidden = false;
    return;
  }
  if (!state.publicKey) {
    setAlertUi({ message: "Push is not configured on the server yet." });
    return;
  }
  state.reg = await navigator.serviceWorker.ready;
  state.sub = await state.reg.pushManager.getSubscription();
  if (state.sub) {
    setAlertUi({ message: "Alerts are on for this device.", disable: true, test: true });
  } else if (Notification.permission === "denied") {
    setAlertUi({
      message: "Notifications are blocked for this site. Turn them back on in your browser settings.",
    });
  } else {
    setAlertUi({ message: "Alerts are off for this device.", enable: true });
  }
}

async function enable() {
  $("enable").disabled = true;
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      setAlertUi({ message: "You did not allow notifications.", enable: true });
      return;
    }
    const sub = await state.reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8Array(state.publicKey),
    });
    const { ok } = await api("subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sub.toJSON()),
    });
    if (!ok) throw new Error("server refused the subscription");
    state.sub = sub;
    setAlertUi({ message: "Alerts are on for this device.", disable: true, test: true });
  } catch (err) {
    setAlertUi({ message: `Could not turn alerts on: ${err.message}`, enable: true });
  } finally {
    $("enable").disabled = false;
  }
}

async function disable() {
  $("disable").disabled = true;
  try {
    const endpoint = state.sub && state.sub.endpoint;
    if (state.sub) await state.sub.unsubscribe();
    await api("unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
    state.sub = null;
    setAlertUi({ message: "Alerts are off for this device.", enable: true });
  } finally {
    $("disable").disabled = false;
  }
}

// "Nothing sent" told nobody anything. Each of these is a different problem
// with a different fix, so name the one that actually happened.
const PUSH_FAILURES = {
  "no-keys": "The server has no push keys set, so nothing can be sent. That's mine to fix.",
  "no-devices":
    "This phone isn't registered yet. Tap Turn off, then Turn on alerts again, and allow the permission when Android asks.",
  "all-rejected": "The phone is registered but the push service rejected it.",
};

async function test() {
  $("test").disabled = true;
  $("test").textContent = "Sending…";
  const { body } = await api("test", { method: "POST" });
  const failed = !body.sent;
  $("test").textContent = failed ? "Nothing sent" : "Sent";
  // Put the explanation where the alert status already is, so it is readable
  // rather than crammed into a button.
  if (failed) {
    const why = PUSH_FAILURES[body.reason] || "Nothing was sent and the server didn't say why.";
    $("alert-state").textContent = why + (body.detail ? ` (${body.detail})` : "");
  }
  setTimeout(() => {
    $("test").textContent = "Send a test";
    $("test").disabled = false;
  }, 2500);
}

async function checkNow() {
  const btn = $("check");
  btn.disabled = true;
  btn.textContent = "Checking…";
  const { status, body } = await api("check", { method: "POST" });
  if (status === 429) {
    btn.textContent = `Wait ${body.wait}s`;
  } else {
    btn.textContent = body.found ? `${body.found} new` : "Nothing new";
    await loadState();
  }
  setTimeout(() => {
    btn.textContent = "Check now";
    btn.disabled = false;
  }, 2500);
}

async function boot() {
  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("/sw.js");
    } catch (err) {
      console.warn("service worker failed", err);
    }
  }
  $("enable").addEventListener("click", enable);
  $("disable").addEventListener("click", disable);
  $("test").addEventListener("click", test);
  $("check").addEventListener("click", checkNow);
  await loadState();
  // Refresh on its own so the button is never the only way to see what's
  // there. Skip the tick while the app is in the background, because a phone
  // that is asleep gains nothing from it, and refresh the moment it comes
  // back to the front instead: that is when someone is actually looking.
  setInterval(() => {
    if (document.visibilityState === "visible") loadState();
  }, 120000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") loadState();
  });
}

boot();
