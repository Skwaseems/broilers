"""Verify and register a new WhatsApp number on the Cloud API.

Run it yourself: the OTP and the 6-digit PIN are typed here, and are neither shown nor saved.
Usage: python tools/wa_register_number.py <phone_number_id>
"""
import getpass
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

CONFIG = os.path.join(os.path.dirname(__file__), "..", "whatsapp", "config.json")
cfg = json.load(open(CONFIG, encoding="utf-8"))
BASE = "https://graph.facebook.com/" + cfg.get("api_version", "v21.0") + "/"
PHONE_ID = sys.argv[1]


def call(path, fields=None):
    data = urllib.parse.urlencode(fields).encode() if fields is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers={"Authorization": "Bearer " + cfg["access_token"]})
    try:
        return json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e:
        err = json.loads(e.read()).get("error", {})
        sys.exit("WhatsApp refused: " + str(err.get("error_user_msg") or err.get("message")))


way = input("Get the code by SMS or a phone call? Type sms or call: ").strip().upper() or "SMS"
call(PHONE_ID + "/request_code", {"code_method": "VOICE" if way == "CALL" else "SMS", "language": "en"})
call(PHONE_ID + "/verify_code", {"code": input("Code sent. Type the OTP you received: ").strip()})
print("Number verified.")

print("Now choose a new 6-digit PIN for this number and keep it safe. It won't show as you type.")
pin = getpass.getpass("PIN: ").strip()
if len(pin) != 6 or not pin.isdigit() or pin != getpass.getpass("PIN again: ").strip():
    sys.exit("The PIN must be 6 digits, typed the same twice. Run this again; a new OTP will be sent.")
call(PHONE_ID + "/register", {"messaging_product": "whatsapp", "pin": pin})
print("Done. The number is registered. Tell Claude so it can switch the system over.")
