# devlog

A tiny Twitter-style microblog. Write short updates in a local composer;
they're committed to this repo and show up on a GitHub Pages feed that
refreshes itself.

- **Feed:** https://aniketmaithani.net/devlog/
- **Composer:** runs only on your machine, never served by Pages.

## Run the composer

Requirements: Python 3.8+ (standard library only) and the
[GitHub CLI](https://cli.github.com/) logged in (`gh auth status`).

```sh
python3 composer/server.py
```

Then open http://127.0.0.1:8037.

- **Enter** posts, **Shift+Enter** adds a new line.
- The project field is optional and remembers its last value.
- After posting, the status reads **Committed**, then **Live on Pages**
  once the Pages deploy for that commit finishes (usually under a minute).

## Change the length limit

Edit `composer/config.json`:

```json
{"limit_type": "words", "limit": 160}
```

`limit_type` is `"words"` or `"chars"`. The file is re-read on every
request, so a browser refresh picks up the change without restarting the
server. The limit is enforced in the browser and again on the server.

## How it works

```
composer (127.0.0.1:8037) --gh api--> GitHub contents API --> commit on main
                                                                  |
feed (GitHub Pages, /docs) <--polls posts.json every 15s-- Pages deploy
```

1. **Commit through gh.** `POST /post` validates the text, builds
   `{"id", "text", "project", "created_at"}`, fetches
   `docs/posts.json` with `gh api`, puts the new post first, and PUTs the
   file back with its `sha` (JSON body piped through `--input -`). The
   commit message is `post: <first 50 chars>`. If GitHub reports a stale
   sha (409/422), it refetches and retries once. No local git checkout is
   touched.
2. **Pages deploy.** Pages serves `main:/docs`, so each commit triggers a
   deploy. The composer's `GET /status?commit=<sha>` reads
   `repos/{owner}/devlog/pages/builds/latest` and reports `live` once the
   latest build is for that commit and has status `built`.
3. **Feed polling.** `docs/app.js` fetches `posts.json?t=<Date.now()>`
   on load and every 15 seconds (the query string gets past the CDN
   cache), adds new posts at the top with a short animation, and refreshes
   relative times every 30 seconds. Post text is rendered with
   `textContent` only; URLs become `http(s)` links and line breaks are
   kept.

## The page

The feed is a profile page in a MySpace-ish style: the profile (photo,
post count, last post, current project), contact links and details on the
left, and a Twitter-style timeline on the right. The photo is
`docs/avatar.jpg` (a copy of the GitHub avatar). The name, links and
location are plain HTML in `docs/index.html`. The stats and project list
are computed from `posts.json` in `docs/app.js`.

## Layout

```
docs/       public feed (index.html, app.js, style.css, posts.json,
            avatar.jpg)
composer/   local composer (server.py, index.html, config.json)
```

## Security notes

The composer binds to `127.0.0.1` only, rejects requests whose `Host` or
`Origin` isn't the composer itself, and requires a JSON body, so other
websites open in your browser can't post on your behalf. `gh` is always
called with list arguments, never through a shell.
