"""Shared config loading and Graph API helpers. Standard library only."""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.json")
PRODUCTS_PATH = os.path.join(HERE, "products.json")
HANDLES_PATH = os.path.join(HERE, "media_handles.json")
IMG_DIR = os.path.join(os.path.dirname(HERE), "images", "products")

REQUIRED = ["access_token", "app_id", "waba_id", "phone_number_id"]


def load_config():
    if not os.path.exists(CONFIG_PATH):
        sys.exit(
            "whatsapp/config.json not found.\n"
            "Copy config.example.json to config.json and fill in your Meta credentials."
        )
    with open(CONFIG_PATH, encoding="utf-8") as f:
        cfg = json.load(f)
    missing = [k for k in REQUIRED if not cfg.get(k) or str(cfg[k]).startswith("PASTE_")]
    if missing:
        sys.exit("config.json is still missing: " + ", ".join(missing))
    cfg.setdefault("api_version", "v21.0")
    cfg.setdefault("language", "en")
    cfg.setdefault("template_name", "sharhan_weekly_catalogue")
    return cfg


def load_products():
    with open(PRODUCTS_PATH, encoding="utf-8") as f:
        return json.load(f)


def graph_url(cfg, path):
    return f"https://graph.facebook.com/{cfg['api_version']}/{path.lstrip('/')}"


def request(url, method="GET", token=None, json_body=None, raw_body=None, headers=None,
            fatal=True):
    """Returns parsed JSON. On error: exits, or returns None when fatal=False
    (used for bulk sends, so one bad number doesn't kill the whole batch)."""
    hdrs = dict(headers or {})
    if token:
        hdrs.setdefault("Authorization", "Bearer " + token)

    data = None
    if json_body is not None:
        data = json.dumps(json_body).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json")
    elif raw_body is not None:
        data = raw_body

    req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            err = json.loads(body).get("error", {})
            msg = err.get("error_user_msg") or err.get("message") or body
            detail = err.get("error_user_title", "")
        except json.JSONDecodeError:
            msg, detail = body, ""
        text = f"Meta API error ({e.code}): {detail} {msg}".rstrip()
        if fatal:
            sys.exit("\n" + text)
        print(text)
        return None
    except urllib.error.URLError as e:
        text = f"Network error reaching Meta: {e.reason}"
        if fatal:
            sys.exit("\n" + text)
        print(text)
        return None
