"use strict";

(() => {
  const POLL_MS = 15000;
  const CLOCK_MS = 30000;
  const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;
  const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

  const feedEl = document.getElementById("feed");
  const emptyEl = document.getElementById("empty");
  const statusEl = document.getElementById("feed-status");

  const rendered = new Map(); // post id -> <li>
  let firstLoad = true;
  let loading = false;

  // --- time ---------------------------------------------------------------

  function relativeTime(date) {
    const seconds = Math.round((Date.now() - date.getTime()) / 1000);
    if (seconds < 45) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: date.getFullYear() === new Date().getFullYear()
        ? undefined
        : "numeric",
    });
  }

  function refreshTimes() {
    for (const timeEl of feedEl.querySelectorAll("time[datetime]")) {
      timeEl.textContent = relativeTime(new Date(timeEl.dateTime));
    }
  }

  // --- text ---------------------------------------------------------------

  function safeHref(candidate) {
    try {
      const url = new URL(candidate);
      return url.protocol === "http:" || url.protocol === "https:"
        ? url.href
        : null;
    } catch (e) {
      return null;
    }
  }

  function makeLink(raw) {
    const href = safeHref(raw);
    if (!href) return document.createTextNode(raw);
    const a = document.createElement("a");
    a.href = href;
    a.textContent = raw;
    a.target = "_blank";
    a.rel = "noopener noreferrer nofollow";
    return a;
  }

  // Appends text to parent as text nodes and <a> elements. Post data is
  // only ever assigned through textContent / createTextNode, never HTML.
  function appendLinkified(parent, text) {
    let last = 0;
    for (const match of text.matchAll(URL_PATTERN)) {
      const trailing = (match[0].match(TRAILING_PUNCTUATION) || [""])[0];
      const url = match[0].slice(0, match[0].length - trailing.length);
      parent.append(document.createTextNode(text.slice(last, match.index)));
      parent.append(makeLink(url));
      last = match.index + url.length;
    }
    parent.append(document.createTextNode(text.slice(last)));
  }

  // --- rendering ----------------------------------------------------------

  function renderPost(post) {
    const li = document.createElement("li");
    li.className = "post";
    li.dataset.id = String(post.id);

    const text = document.createElement("p");
    text.className = "post-text";
    appendLinkified(text, String(post.text ?? ""));

    const meta = document.createElement("div");
    meta.className = "post-meta";
    if (post.project) {
      const pill = document.createElement("span");
      pill.className = "pill";
      pill.textContent = String(post.project);
      meta.append(pill);
    }
    const created = new Date(post.created_at);
    if (!Number.isNaN(created.getTime())) {
      const timeEl = document.createElement("time");
      timeEl.dateTime = created.toISOString();
      timeEl.title = created.toLocaleString();
      timeEl.textContent = relativeTime(created);
      meta.append(timeEl);
    }

    li.append(text, meta);
    return li;
  }

  function markNew(li) {
    li.classList.add("is-new");
    li.addEventListener("animationend", (event) => {
      if (event.animationName === "new-highlight") {
        li.classList.remove("is-new");
      }
    });
  }

  function removeMissing(ids) {
    for (const [id, li] of rendered) {
      if (!ids.has(id)) {
        li.remove();
        rendered.delete(id);
      }
    }
  }

  function addNew(posts, animate) {
    // posts is newest first; insert oldest-new first so order holds.
    const fresh = posts.filter((post) => !rendered.has(String(post.id)));
    for (const post of fresh.reverse()) {
      const li = renderPost(post);
      if (animate) markNew(li);
      rendered.set(String(post.id), li);
      feedEl.prepend(li);
    }
  }

  function render(posts) {
    const valid = posts
      .filter((post) => post && post.id != null)
      .sort((a, b) => Number(b.id) - Number(a.id));
    removeMissing(new Set(valid.map((post) => String(post.id))));
    addNew(valid, !firstLoad);
    emptyEl.hidden = valid.length > 0;
  }

  // --- polling ------------------------------------------------------------

  async function load() {
    if (loading) return;
    loading = true;
    try {
      const res = await fetch(`posts.json?t=${Date.now()}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const posts = await res.json();
      render(Array.isArray(posts) ? posts : []);
      statusEl.textContent = "";
      firstLoad = false;
    } catch (e) {
      statusEl.textContent = "Couldn't refresh the feed. Retrying…";
    } finally {
      loading = false;
    }
  }

  load();
  setInterval(load, POLL_MS);
  setInterval(refreshTimes, CLOCK_MS);
})();
