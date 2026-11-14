#!/usr/bin/env python3
"""Local devlog composer.

Serves a small posting UI on 127.0.0.1:8037 and commits each post to
docs/posts.json in the GitHub repo through the gh CLI.
"""

import base64
import json
import re
import subprocess
import threading
import time
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HOST = "127.0.0.1"
PORT = 8037
REPO = "devlog"
BRANCH = "main"
POSTS_PATH = "docs/posts.json"

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.json"
UI_PATH = BASE_DIR / "index.html"

LIMIT_TYPES = ("words", "chars")
MAX_BODY_BYTES = 64 * 1024
MAX_PROJECT_CHARS = 40
COMMIT_PREVIEW_CHARS = 50
GH_TIMEOUT_SECONDS = 30

CONFLICT_PATTERN = re.compile(r"HTTP (409|422)")
NOT_FOUND_PATTERN = re.compile(r"HTTP 404")
SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")

ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
ALLOWED_ORIGINS = {f"http://{host}" for host in ALLOWED_HOSTS}

PUBLISH_LOCK = threading.Lock()


class GhError(Exception):
    """A gh command failed."""


class ConflictError(GhError):
    """GitHub rejected a write because the file sha was stale."""


class ValidationError(Exception):
    """A post did not pass validation."""


# --- gh helpers -----------------------------------------------------------

def run_gh(args, stdin_text=None):
    """Run gh with list args and return stdout, raising GhError."""
    result = subprocess.run(
        ["gh", *args],
        input=stdin_text,
        capture_output=True,
        text=True,
        timeout=GH_TIMEOUT_SECONDS,
        check=False,
    )
    if result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip()
        if CONFLICT_PATTERN.search(message):
            raise ConflictError(message)
        raise GhError(message or "gh exited with an error")
    return result.stdout


def get_owner():
    """Return the login of the authenticated gh user."""
    return run_gh(["api", "user", "-q", ".login"]).strip()


def contents_endpoint(owner):
    return f"repos/{owner}/{REPO}/contents/{POSTS_PATH}"


def feed_url(owner):
    return f"https://{owner.lower()}.github.io/{REPO}/"


# --- config and validation ------------------------------------------------

def load_config():
    """Read config.json fresh so edits apply without a restart."""
    raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    limit_type = raw.get("limit_type", "words")
    if limit_type not in LIMIT_TYPES:
        raise ValueError(f"limit_type must be one of {LIMIT_TYPES}")
    limit = int(raw.get("limit", 160))
    if limit < 1:
        raise ValueError("limit must be a positive integer")
    return {"limit_type": limit_type, "limit": limit}


def count_units(text, limit_type):
    """Count words or characters (code points) in text."""
    if limit_type == "words":
        return len(text.split())
    return len(text)


def clean_text(raw):
    if not isinstance(raw, str):
        raise ValidationError("text must be a string")
    return raw.replace("\r\n", "\n").replace("\r", "\n").strip()


def clean_project(raw):
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise ValidationError("project must be a string")
    project = " ".join(raw.split())
    if len(project) > MAX_PROJECT_CHARS:
        raise ValidationError(
            f"project must be {MAX_PROJECT_CHARS} characters or fewer"
        )
    return project or None


def validate_text(text, config):
    if not text:
        raise ValidationError("post is empty")
    used = count_units(text, config["limit_type"])
    if used > config["limit"]:
        raise ValidationError(
            f"post is {used} {config['limit_type']}, "
            f"limit is {config['limit']}"
        )


# --- posts ----------------------------------------------------------------

def utc_now_iso():
    now = datetime.now(timezone.utc)
    return now.isoformat(timespec="seconds").replace("+00:00", "Z")


def build_post(text, project):
    return {
        "id": int(time.time() * 1000),
        "text": text,
        "project": project,
        "created_at": utc_now_iso(),
    }


def commit_message(text):
    preview = " ".join(text.split())[:COMMIT_PREVIEW_CHARS]
    return f"post: {preview}"


def encode_posts(posts):
    body = json.dumps(posts, indent=2, ensure_ascii=False) + "\n"
    return base64.b64encode(body.encode("utf-8")).decode("ascii")


def decode_posts(content):
    text = base64.b64decode(content).decode("utf-8").strip()
    posts = json.loads(text or "[]")
    if not isinstance(posts, list):
        raise GhError("posts.json does not contain a JSON array")
    return posts


def fetch_posts(owner):
    """Return (posts, sha); sha is None if posts.json does not exist."""
    endpoint = f"{contents_endpoint(owner)}?ref={BRANCH}"
    try:
        raw = run_gh(["api", endpoint])
    except GhError as error:
        if NOT_FOUND_PATTERN.search(str(error)):
            return [], None
        raise
    data = json.loads(raw)
    return decode_posts(data["content"]), data["sha"]


def put_posts(owner, posts, sha, message):
    """Write posts.json and return the new commit sha."""
    body = {
        "message": message,
        "content": encode_posts(posts),
        "branch": BRANCH,
    }
    if sha:
        body["sha"] = sha
    args = ["api", "-X", "PUT", contents_endpoint(owner), "--input", "-"]
    raw = run_gh(args, stdin_text=json.dumps(body))
    return json.loads(raw)["commit"]["sha"]


def prepend_and_commit(owner, post):
    posts, sha = fetch_posts(owner)
    return put_posts(owner, [post, *posts], sha, commit_message(post["text"]))


def publish_post(owner, post):
    """Commit the post, refetching and retrying once on a sha conflict."""
    with PUBLISH_LOCK:
        try:
            return prepend_and_commit(owner, post)
        except ConflictError:
            return prepend_and_commit(owner, post)


# --- pages status ---------------------------------------------------------

def classify_build(build, commit):
    """Map a Pages build to pending, building, live or errored."""
    if commit and build.get("commit") != commit:
        return "pending"
    status = build.get("status")
    if status == "built":
        return "live"
    if status == "errored":
        return "errored"
    return "building"


def fetch_pages_status(owner, commit):
    try:
        raw = run_gh(["api", f"repos/{owner}/{REPO}/pages/builds/latest"])
    except GhError:
        return {"state": "pending", "build_status": None}
    build = json.loads(raw)
    return {
        "state": classify_build(build, commit),
        "build_status": build.get("status"),
        "build_commit": build.get("commit"),
    }


# --- HTTP -----------------------------------------------------------------

class ComposerHandler(BaseHTTPRequestHandler):
    server_version = "devlog-composer/1.0"

    def do_GET(self):
        if not self.request_allowed():
            return
        path = urlparse(self.path).path
        routes = {
            "/": self.serve_ui,
            "/config": self.serve_config,
            "/status": self.serve_status,
        }
        handler = routes.get(path)
        if handler is None:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        handler()

    def do_POST(self):
        if not self.request_allowed():
            return
        if urlparse(self.path).path != "/post":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        self.handle_post()

    # Guards against other sites and DNS rebinding reaching this server.
    def request_allowed(self):
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        if host not in ALLOWED_HOSTS:
            self.send_json(HTTPStatus.FORBIDDEN, {"error": "bad host"})
            return False
        if origin is not None and origin not in ALLOWED_ORIGINS:
            self.send_json(HTTPStatus.FORBIDDEN, {"error": "bad origin"})
            return False
        return True

    def serve_ui(self):
        body = UI_PATH.read_bytes()
        self.send_bytes(HTTPStatus.OK, body, "text/html; charset=utf-8")

    def serve_config(self):
        config = load_config()
        config["feed_url"] = feed_url(self.server.owner)
        self.send_json(HTTPStatus.OK, config)

    def serve_status(self):
        query = parse_qs(urlparse(self.path).query)
        commit = query.get("commit", [""])[0]
        if commit and not SHA_PATTERN.match(commit):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "bad commit"})
            return
        status = fetch_pages_status(self.server.owner, commit or None)
        self.send_json(HTTPStatus.OK, status)

    def handle_post(self):
        try:
            payload = self.read_json_body()
            text = clean_text(payload.get("text"))
            project = clean_project(payload.get("project"))
            validate_text(text, load_config())
            post = build_post(text, project)
            commit = publish_post(self.server.owner, post)
        except ValidationError as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
        except subprocess.TimeoutExpired:
            self.send_json(
                HTTPStatus.GATEWAY_TIMEOUT, {"error": "gh timed out"}
            )
        except GhError as error:
            self.send_json(HTTPStatus.BAD_GATEWAY, {"error": str(error)})
        else:
            self.send_json(HTTPStatus.OK, {"post": post, "commit": commit})

    def read_json_body(self):
        content_type = self.headers.get("Content-Type", "")
        if not content_type.startswith("application/json"):
            raise ValidationError("Content-Type must be application/json")
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            raise ValidationError("request body is missing or too large")
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValidationError("body is not valid JSON") from error
        if not isinstance(payload, dict):
            raise ValidationError("body must be a JSON object")
        return payload

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_bytes(status, body, "application/json")

    def send_bytes(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)


def main():
    load_config()
    owner = get_owner()
    server = ThreadingHTTPServer((HOST, PORT), ComposerHandler)
    server.owner = owner
    print(f"devlog composer: http://{HOST}:{PORT}  (repo {owner}/{REPO})")
    print(f"public feed:     {feed_url(owner)}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
