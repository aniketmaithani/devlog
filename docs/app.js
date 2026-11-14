"use strict";

(() => {
  const POLL_MS = 15000;
  const CLOCK_MS = 30000;
  const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;
  const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;
  const RECENT_MS = 60 * 60 * 1000; // "Posted recently" window
  const AUTHOR_NAME = document.body.dataset.name || "devlog";
  const AUTHOR_HANDLE = document.body.dataset.handle || "devlog";

  const feedEl = document.getElementById("feed");
  const emptyEl = document.getElementById("empty");
  const statusEl = document.getElementById("feed-status");
  const postCountEl = document.getElementById("post-count");
  const statPostsEl = document.getElementById("stat-posts");
  const statLastEl = document.getElementById("stat-last");
  const statNowEl = document.getElementById("stat-now");
  const onlineEl = document.getElementById("online");
  const projectListEl = document.getElementById("project-list");

  const rendered = new Map(); // post id -> <li>
  let firstLoad = true;
  let currentPosts = [];
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
    for (const timeEl of document.querySelectorAll("time[datetime]")) {
      timeEl.textContent = relativeTime(new Date(timeEl.dateTime));
    }
    const latest = currentPosts[0];
    const created = latest ? new Date(latest.created_at) : null;
    onlineEl.hidden = !(created && Date.now() - created < RECENT_MS);
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

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function makePill(project) {
    return el("span", "pill", String(project));
  }

  function makeTime(created) {
    const timeEl = el("time", null, relativeTime(created));
    timeEl.dateTime = created.toISOString();
    timeEl.title = created.toLocaleString();
    return timeEl;
  }

  function renderPost(post) {
    const li = el("li", "post");
    li.dataset.id = String(post.id);

    const avatar = el("img", "post-avatar");
    avatar.src = "avatar.jpg";
    avatar.alt = "";
    avatar.width = 44;
    avatar.height = 44;

    const body = el("div", "post-body");
    const head = el("div", "post-head");
    head.append(
      el("span", "post-name", AUTHOR_NAME),
      el("span", "post-handle", `@${AUTHOR_HANDLE}`),
    );
    const created = new Date(post.created_at);
    if (!Number.isNaN(created.getTime())) {
      head.append(el("span", "post-dot", "·"), makeTime(created));
    }

    const text = el("p", "post-text");
    appendLinkified(text, String(post.text ?? ""));
    body.append(head, text);

    if (post.project) {
      const foot = el("div", "post-foot");
      foot.append(makePill(post.project));
      body.append(foot);
    }

    li.append(avatar, body);
    return li;
  }

  // --- profile stats ------------------------------------------------------

  function projectCounts(posts) {
    const counts = new Map();
    for (const post of posts) {
      if (!post.project) continue;
      const name = String(post.project);
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1]);
  }

  function updateProjects(posts) {
    const counts = projectCounts(posts);
    if (!counts.length) {
      projectListEl.textContent = "—";
      return;
    }
    projectListEl.replaceChildren(
      ...counts.map(([name, n]) => {
        const pill = makePill(name);
        pill.title = `${n} post${n === 1 ? "" : "s"}`;
        return pill;
      }),
    );
  }

  function updateStats(posts) {
    const count = posts.length;
    statPostsEl.textContent = String(count);
    postCountEl.textContent = `${count} post${count === 1 ? "" : "s"}`;
    const latest = posts[0];
    const created = latest ? new Date(latest.created_at) : null;
    const valid = created && !Number.isNaN(created.getTime());
    statLastEl.replaceChildren(valid ? makeTime(created) : "never");
    const current = posts.find((post) => post.project);
    statNowEl.textContent = current ? String(current.project) : "—";
    onlineEl.hidden = !(valid && Date.now() - created < RECENT_MS);
    updateProjects(posts);
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
    currentPosts = valid;
    updateStats(valid);
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
