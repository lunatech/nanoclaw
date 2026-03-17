#!/usr/bin/env python3

from __future__ import print_function

import json
import os
import re
import sys

try:
    from html import unescape as html_unescape
except ImportError:
    import HTMLParser

    _html_parser = HTMLParser.HTMLParser()

    def html_unescape(value):
        return _html_parser.unescape(value)

from email import header as email_header
from email.parser import Parser
from email.utils import parseaddr

try:
    from urllib.error import HTTPError, URLError
    from urllib.request import Request, urlopen
except ImportError:
    from urllib2 import HTTPError, URLError, Request, urlopen


MAX_MIME_DEPTH = 10
UNTRUSTED_OPEN_TAG = "<untrusted>"
UNTRUSTED_CLOSE_TAG = "</untrusted>"


def require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError("%s is required" % name)
    return value


def normalize_newlines(text):
    return text.replace("\r\n", "\n").replace("\r", "\n")


def split_header_section(raw_email):
    normalized = normalize_newlines(raw_email)
    split_at = normalized.find("\n\n")
    if split_at == -1:
        return normalized.rstrip("\n"), ""
    return normalized[:split_at], normalized[split_at + 2 :]


def unfold_header_lines(headers_text):
    result = []
    for line in headers_text.split("\n"):
        if not line:
            continue
        if (line.startswith(" ") or line.startswith("\t")) and result:
            result[-1] += " " + line.strip()
        else:
            result.append(line.rstrip())
    return result


def decode_mime_words(value):
    fragments = []
    for chunk, charset in email_header.decode_header(value or ""):
        if isinstance(chunk, bytes):
            encoding = charset or "utf-8"
            try:
                fragments.append(chunk.decode(encoding))
            except (LookupError, UnicodeDecodeError):
                fragments.append(chunk.decode("utf-8", "replace"))
        else:
            fragments.append(chunk)
    return "".join(fragments)


def derive_sender_name(message):
    from_header = message.get("From", "")
    decoded = decode_mime_words(from_header).strip()
    display_name, address = parseaddr(decoded)
    if display_name:
        return display_name.strip().strip('"')
    if address:
        return address.strip()
    return "email"


def normalize_text_body(text):
    normalized = normalize_newlines(text)
    normalized = re.sub(r"[ \t]+\n", "\n", normalized)
    normalized = re.sub(r"\n{3,}", "\n\n", normalized)
    return normalized.strip()


def html_to_text(value):
    text = re.sub(r"(?is)<script[\s\S]*?</script>", "", value)
    text = re.sub(r"(?is)<style[\s\S]*?</style>", "", text)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(
        r"(?i)</(p|div|section|article|li|tr|h1|h2|h3|h4|h5|h6)>",
        "\n",
        text,
    )
    text = re.sub(r"(?is)<[^>]+>", "", text)
    return normalize_text_body(html_unescape(text))


def part_has_payload(part):
    payload = part.get_payload(decode=True)
    if payload:
        return True
    raw_payload = part.get_payload()
    if isinstance(raw_payload, str):
        return raw_payload.strip() != ""
    return False


def parse_entity(message, depth):
    if depth > MAX_MIME_DEPTH:
        return {"text_plain": [], "text_html": [], "has_attachment": True}

    if message.is_multipart():
        merged = {"text_plain": [], "text_html": [], "has_attachment": False}
        for child in message.get_payload():
            child_result = parse_entity(child, depth + 1)
            merged["text_plain"].extend(child_result["text_plain"])
            merged["text_html"].extend(child_result["text_html"])
            merged["has_attachment"] = (
                merged["has_attachment"] or child_result["has_attachment"]
            )
        return merged

    content_type = (message.get_content_type() or "text/plain").lower()
    disposition = (message.get("Content-Disposition") or "").lower()
    filename = message.get_filename()

    if "attachment" in disposition or filename:
        return {"text_plain": [], "text_html": [], "has_attachment": True}

    payload_bytes = message.get_payload(decode=True)
    charset = message.get_content_charset() or "utf-8"
    if payload_bytes is None:
        raw_payload = message.get_payload()
        if isinstance(raw_payload, str):
            decoded_body = raw_payload
        else:
            decoded_body = ""
    else:
        try:
            decoded_body = payload_bytes.decode(charset)
        except (LookupError, UnicodeDecodeError):
            decoded_body = payload_bytes.decode("utf-8", "replace")

    if content_type == "text/plain":
        return {
            "text_plain": [normalize_text_body(decoded_body)],
            "text_html": [],
            "has_attachment": False,
        }

    if content_type == "text/html":
        return {
            "text_plain": [],
            "text_html": [html_to_text(decoded_body)],
            "has_attachment": False,
        }

    if part_has_payload(message):
        return {"text_plain": [], "text_html": [], "has_attachment": True}

    return {"text_plain": [], "text_html": [], "has_attachment": False}


def collect_forwarded_text(headers_text, body_text):
    decoded_headers = []
    for line in unfold_header_lines(headers_text):
        separator = line.find(":")
        if separator == -1:
            decoded_headers.append(decode_mime_words(line))
            continue
        key = line[:separator]
        value = line[separator + 1 :].strip()
        decoded_headers.append("%s: %s" % (key, decode_mime_words(value)))

    sections = ["Forwarded email (full text):"]
    trimmed_headers = "\n".join(decoded_headers).strip()
    if trimmed_headers:
        sections.append(trimmed_headers)
    sections.append("")
    sections.append(body_text)
    return "\n".join(sections).strip()


def parse_email(raw_email):
    headers_text, _body = split_header_section(raw_email)
    message = Parser().parsestr(raw_email)
    entity = parse_entity(message, 0)

    body_text = ""
    for value in entity["text_plain"]:
        if value:
            body_text = value
            break
    if not body_text:
        for value in entity["text_html"]:
            if value:
                body_text = value
                break

    return {
        "message_id": message.get("Message-ID"),
        "sender_name": derive_sender_name(message),
        "has_attachment": entity["has_attachment"],
        "forwarded_text": collect_forwarded_text(headers_text, body_text),
    }


def wrap_untrusted_content(text):
    return "%s%s%s" % (UNTRUSTED_OPEN_TAG, text, UNTRUSTED_CLOSE_TAG)


def post_email(endpoint, token, payload):
    data = json.dumps(payload).encode("utf-8")
    request = Request(endpoint, data=data)
    request.add_header("Authorization", "Bearer %s" % token)
    request.add_header("Content-Type", "application/json")
    request.get_method = lambda: "POST"
    return urlopen(request)


def main():
    endpoint = require_env("INJECT_EMAIL_URL")
    token = require_env("INJECT_SECRET")
    chat_jid = require_env("INJECT_CHAT_JID")
    sender_name = os.environ.get("INJECT_EMAIL_SENDER_NAME")

    raw_email = sys.stdin.read()
    parsed = parse_email(raw_email)

    if parsed["has_attachment"]:
        message_id = parsed["message_id"] or "unknown"
        print(
            "discarded email %s: attachments are not supported by the email forwarder"
            % message_id,
            file=sys.stderr,
        )
        return 2

    payload = {
        "chatJid": chat_jid,
        "senderName": sender_name or parsed["sender_name"] or "email",
        "wrappedEmail": wrap_untrusted_content(parsed["forwarded_text"]),
    }
    if parsed["message_id"]:
        payload["messageId"] = parsed["message_id"]

    try:
        response = post_email(endpoint, token, payload)
        status = getattr(response, "getcode", lambda: 200)()
        if 200 <= status < 300:
            return 0

        body = response.read().decode("utf-8", "replace")
        print(
            "failed forwarding email %s: %s %s"
            % (parsed["message_id"] or "unknown", status, body),
            file=sys.stderr,
        )
        return 1
    except HTTPError as error:
        body = error.read().decode("utf-8", "replace")
        print(
            "failed forwarding email %s: %s %s %s"
            % (
                parsed["message_id"] or "unknown",
                error.code,
                getattr(error, "reason", ""),
                body,
            ),
            file=sys.stderr,
        )
        return 1
    except URLError as error:
        print(
            "failed forwarding email %s: %s"
            % (parsed["message_id"] or "unknown", error),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
