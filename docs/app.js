"use strict";

(() => {
  const POLL_MS = 15000;
  const CLOCK_MS = 30000;
  const PAGE_SIZE = 10;
  const SEARCH_DEBOUNCE_MS = 150;
  const RECENT_MS = 60 * 60 * 1000; // "Posted recently" window
  const NEW_BADGE_MS = 24 * 60 * 60 * 1000; // NEW! on the latest post
  const TICKER_CHARS = 160;
  const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;
  const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;
  const AUTHOR_NAME = document.body.dataset.name || "devlog";
  const AUTHOR_HANDLE = document.body.dataset.handle || "devlog";

  const $ = (id) => document.getElementById(id);
  const feedEl = $("feed");
  const emptyEl = $("empty");
  const statusEl = $("feed-status");
  const pagerEl = $("pager");
  const searchEl = $("search");
  const chipEl = $("filter-chip");
  const timelineEl = $("timeline");
  const timelineTitleEl = $("timeline-title");
  const postCountEl = $("post-count");
  const statPostsEl = $("stat-posts");
  const statLastEl = $("stat-last");
  const onlineEl = $("online");
  const nowNoneEl = $("now-none");
  const projectListEl = $("project-list");
  const odometerEl = $("odometer");
  const tickerEl = $("ticker");
  const tickerCopyEl = $("ticker-copy");

  let posts = []; // valid posts, newest first
  let lastPayload = null; // raw posts.json text, to skip no-op renders
  let seenIds = null; // ids from the previous load (null before first)
  let freshIds = new Set(); // ids to animate on the next render
  let view = readView();
  let loading = false;
  let searchTimer = null;

  // --- small DOM helpers --------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
  }

  function validDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // --- view state <-> URL -------------------------------------------------

  function readView() {
    const params = new URLSearchParams(location.search);
    const page = parseInt(params.get("page") || "1", 10);
    return {
      q: params.get("q") || "",
      project: params.get("project") || "",
      page: Number.isFinite(page) && page > 0 ? page : 1,
    };
  }

  function viewHref(next) {
    const params = new URLSearchParams();
    if (next.project) params.set("project", next.project);
    if (next.q) params.set("q", next.q);
    if (next.page > 1) params.set("page", String(next.page));
    const query = params.toString();
    return `${location.pathname}${query ? `?${query}` : ""}`;
  }

  function setView(next, { push = true, scroll = false } = {}) {
    view = next;
    const href = viewHref(view);
    if (push) history.pushState(null, "", href);
    else history.replaceState(null, "", href);
    renderTimeline();
    if (scroll && timelineEl.getBoundingClientRect().top < 0) {
      timelineEl.scrollIntoView({ block: "start" });
    }
  }

  // Plain left-clicks on our links change the view in place; modified
  // clicks (new tab, etc.) fall through to the real href.
  function routeLink(link, next, options) {
    link.href = viewHref(next);
    link.addEventListener("click", (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey ||
          event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      setView(next, options);
    });
    return link;
  }

  function projectLink(project, className) {
    const link = el("a", className || "tag", project);
    link.title = `Show ${project} timeline`;
    return routeLink(link, { q: "", project, page: 1 }, { scroll: true });
  }

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

  function makeTime(date) {
    const timeEl = el("time", null, relativeTime(date));
    timeEl.dateTime = date.toISOString();
    timeEl.title = date.toLocaleString();
    return timeEl;
  }

  function refreshTimes() {
    for (const timeEl of document.querySelectorAll("time[datetime]")) {
      timeEl.textContent = relativeTime(new Date(timeEl.dateTime));
    }
    updateOnline();
  }

  // --- search -------------------------------------------------------------

  function searchTerms(query) {
    return query.toLowerCase().split(/\s+/).filter(Boolean);
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function termsPattern(terms) {
    if (!terms.length) return null;
    const sorted = [...terms].sort((a, b) => b.length - a.length);
    return new RegExp(sorted.map(escapeRegExp).join("|"), "gi");
  }

  function matchesView(post, terms) {
    if (view.project && String(post.project || "") !== view.project) {
      return false;
    }
    const haystack = `${post.text} ${post.project || ""}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  }

  // --- text: links + highlights, built from text nodes only ---------------

  // Appends text to parent, wrapping search matches in <mark>.
  function appendMarked(parent, text, pattern) {
    if (!pattern) {
      parent.append(text);
      return;
    }
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      parent.append(text.slice(last, match.index));
      parent.append(el("mark", null, match[0]));
      last = match.index + match[0].length;
    }
    parent.append(text.slice(last));
  }

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

  function appendUrl(parent, raw, pattern) {
    const href = safeHref(raw);
    if (!href) {
      appendMarked(parent, raw, pattern);
      return;
    }
    const a = el("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer nofollow";
    appendMarked(a, raw, pattern);
    parent.append(a);
  }

  // Post data only ever reaches the DOM as text nodes / textContent.
  function appendRichText(parent, text, pattern) {
    let last = 0;
    for (const match of text.matchAll(URL_PATTERN)) {
      const trailing = (match[0].match(TRAILING_PUNCTUATION) || [""])[0];
      const url = match[0].slice(0, match[0].length - trailing.length);
      appendMarked(parent, text.slice(last, match.index), pattern);
      appendUrl(parent, url, pattern);
      last = match.index + url.length;
    }
    appendMarked(parent, text.slice(last), pattern);
  }

  // --- posts --------------------------------------------------------------

  function renderPost(post, pattern) {
    const li = el("li", "post");
    li.dataset.id = String(post.id);

    const avatar = el("img", "post-avatar");
    avatar.src = "avatar.jpg";
    avatar.alt = "";
    avatar.width = 44;
    avatar.height = 44;

    const head = el("div", "post-head");
    head.append(
      el("span", "post-name", AUTHOR_NAME),
      el("span", "post-handle", `@${AUTHOR_HANDLE}`),
    );
    const created = validDate(post.created_at);
    if (created) head.append(el("span", "post-dot", "·"), makeTime(created));
    if (isNewest(post, created)) {
      head.append(el("span", "badge-new blink", "NEW!"));
    }

    const text = el("p", "post-text");
    appendRichText(text, String(post.text ?? ""), pattern);

    const body = el("div", "post-body");
    body.append(head, text);
    if (post.project) {
      const foot = el("div", "post-foot");
      const tag = projectLink(String(post.project));
      tag.classList.toggle("is-active", view.project === post.project);
      foot.append(tag);
      body.append(foot);
    }

    li.append(avatar, body);
    if (freshIds.has(String(post.id))) markNew(li);
    return li;
  }

  function isNewest(post, created) {
    return post === posts[0] && created &&
      Date.now() - created.getTime() < NEW_BADGE_MS;
  }

  function markNew(li) {
    li.classList.add("is-new");
    li.addEventListener("animationend", (event) => {
      if (event.animationName === "new-highlight") {
        li.classList.remove("is-new");
      }
    });
  }

  // --- timeline -----------------------------------------------------------

  function pageNumbers(current, total) {
    const wanted = new Set([1, total]);
    for (let n = current - 2; n <= current + 2; n += 1) {
      if (n >= 1 && n <= total) wanted.add(n);
    }
    const sorted = [...wanted].sort((a, b) => a - b);
    const result = [];
    sorted.forEach((n, i) => {
      if (i && n - sorted[i - 1] > 1) result.push(null); // gap
      result.push(n);
    });
    return result;
  }

  function pagerButton(label, page, { current = false, disabled = false,
    ariaLabel } = {}) {
    const link = el("a", "pager-btn", label);
    if (ariaLabel) link.setAttribute("aria-label", ariaLabel);
    if (current) link.setAttribute("aria-current", "page");
    if (disabled) {
      link.classList.add("is-disabled");
      link.setAttribute("aria-disabled", "true");
      return link;
    }
    return routeLink(link, { ...view, page }, { scroll: true });
  }

  function renderPager(page, total) {
    pagerEl.hidden = total <= 1;
    if (total <= 1) {
      pagerEl.replaceChildren();
      return;
    }
    const items = [pagerButton("« Prev", page - 1, {
      disabled: page <= 1, ariaLabel: "Previous page",
    })];
    for (const n of pageNumbers(page, total)) {
      items.push(n === null
        ? el("span", "pager-gap", "…")
        : pagerButton(String(n), n, {
          current: n === page, ariaLabel: `Page ${n}`,
        }));
    }
    items.push(pagerButton("Next »", page + 1, {
      disabled: page >= total, ariaLabel: "Next page",
    }));
    pagerEl.replaceChildren(...items);
  }

  function renderHeader(count) {
    timelineTitleEl.textContent = view.project
      ? `Aniket's devlog » ${view.project}`
      : "Aniket's devlog";
    const filtered = view.project || view.q;
    postCountEl.textContent = filtered
      ? `${plural(count, "match")} of ${posts.length}`
      : plural(posts.length, "post");
    chipEl.hidden = !view.project;
    if (view.project) {
      chipEl.textContent = view.project;
      chipEl.href = viewHref({ ...view, project: "", page: 1 });
    }
  }

  function emptyMessage() {
    if (!posts.length) return "No posts yet.";
    if (view.q) return `Nothing matches “${view.q}”.`;
    return "No posts for this project yet.";
  }

  function renderTimeline() {
    const terms = searchTerms(view.q);
    const matching = posts.filter((post) => matchesView(post, terms));
    const total = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
    const page = Math.min(view.page, total);
    const start = (page - 1) * PAGE_SIZE;
    const pattern = termsPattern(terms);

    feedEl.replaceChildren(...matching
      .slice(start, start + PAGE_SIZE)
      .map((post) => renderPost(post, pattern)));
    freshIds = new Set();

    emptyEl.hidden = matching.length > 0;
    emptyEl.textContent = emptyMessage();
    if (searchEl.value !== view.q) searchEl.value = view.q;
    renderHeader(matching.length);
    renderPager(page, total);
    updateProjects();
  }

  // --- profile ------------------------------------------------------------

  function projectCounts() {
    const counts = new Map();
    for (const post of posts) {
      if (!post.project) continue;
      const name = String(post.project);
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1]);
  }

  function updateProjects() {
    const counts = projectCounts();
    if (!counts.length) {
      projectListEl.textContent = "—";
      return;
    }
    projectListEl.replaceChildren(...counts.map(([name, n]) => {
      const tag = projectLink(name);
      tag.title = `${plural(n, "post")}: show the ${name} timeline`;
      tag.classList.toggle("is-active", view.project === name);
      return tag;
    }));
  }

  function updateNowProject() {
    const current = posts.find((post) => post.project);
    const slot = $("now-project");
    nowNoneEl.hidden = Boolean(current);
    if (!current) {
      slot.hidden = true;
      return;
    }
    const name = String(current.project);
    if (!slot.hidden && slot.textContent === name) return;
    const fresh = projectLink(name, "now-project");
    fresh.id = "now-project";
    slot.replaceWith(fresh);
  }

  function updateOdometer() {
    const digits = String(posts.length).padStart(6, "0");
    odometerEl.replaceChildren(...[...digits].map((d) => el("span", "", d)));
    odometerEl.setAttribute("aria-label", plural(posts.length, "post"));
  }

  function updateTicker() {
    const latest = posts[0];
    let text = "★ no posts yet ★";
    if (latest) {
      const flat = String(latest.text).split(/\s+/).join(" ");
      const clipped = flat.length > TICKER_CHARS
        ? `${flat.slice(0, TICKER_CHARS)}…`
        : flat;
      const project = latest.project ? ` [${latest.project}]` : "";
      text = `★ LATEST${project}: ${clipped} ★`;
    }
    tickerEl.textContent = text;
    tickerCopyEl.textContent = text;
  }

  function updateOnline() {
    const created = posts[0] ? validDate(posts[0].created_at) : null;
    onlineEl.hidden = !(created && Date.now() - created < RECENT_MS);
  }

  function updateProfile() {
    statPostsEl.textContent = String(posts.length);
    const created = posts[0] ? validDate(posts[0].created_at) : null;
    statLastEl.replaceChildren(created ? makeTime(created) : "never");
    updateOnline();
    updateNowProject();
    updateOdometer();
    updateTicker();
  }

  // --- data ---------------------------------------------------------------

  function normalise(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((post) => post && post.id != null)
      .map((post) => ({ ...post, project: post.project || null }))
      .sort((a, b) => Number(b.id) - Number(a.id));
  }

  function applyPosts(next) {
    const ids = new Set(next.map((post) => String(post.id)));
    if (seenIds) {
      freshIds = new Set([...ids].filter((id) => !seenIds.has(id)));
    }
    seenIds = ids;
    posts = next;
    updateProfile();
    renderTimeline();
  }

  async function load() {
    if (loading) return;
    loading = true;
    try {
      const res = await fetch(`posts.json?t=${Date.now()}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.text();
      statusEl.textContent = "";
      if (payload !== lastPayload) {
        lastPayload = payload;
        applyPosts(normalise(JSON.parse(payload)));
      }
    } catch (e) {
      statusEl.textContent = "Couldn't refresh the feed. Retrying…";
    } finally {
      loading = false;
    }
  }

  // --- wiring -------------------------------------------------------------

  searchEl.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      setView({ ...view, q: searchEl.value.trim(), page: 1 }, {
        push: false,
      });
    }, SEARCH_DEBOUNCE_MS);
  });

  searchEl.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && searchEl.value) {
      searchEl.value = "";
      setView({ ...view, q: "", page: 1 }, { push: false });
    }
  });

  $("search-form").addEventListener("submit", (event) => {
    event.preventDefault();
  });

  document.addEventListener("keydown", (event) => {
    const typing = event.target.closest("input, textarea, select");
    if (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      searchEl.focus();
    }
  });

  chipEl.addEventListener("click", (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    setView({ ...view, project: "", page: 1 });
  });

  window.addEventListener("popstate", () => {
    view = readView();
    renderTimeline();
  });

  searchEl.value = view.q;
  load();
  setInterval(load, POLL_MS);
  setInterval(refreshTimes, CLOCK_MS);
})();
