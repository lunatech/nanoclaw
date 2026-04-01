# Email Forwarder JSON Payload Requirements

## Problem Statement

Current email forwarder sends raw email headers as text blob, requiring the receiver to reparse MIME structure. This causes issues:
- MIME boundary escaping breaks parsing (`boundary=&quot;foo&quot;`)
- Duplicate header parsing (forwarder already parsed)
- URL extraction happens twice (forwarder has URLs from HTML)
- Subject/From/Date extracted from text instead of structured fields

## Proposed Solution

Forwarder sends structured JSON payload instead of raw email text.

## JSON Payload Schema

```json
{
  "chatJid": "string (required)",
  "senderName": "string (optional)",
  "email": {
    "messageId": "string (optional)",
    "from": {
      "address": "string (required)",
      "name": "string (optional)"
    },
    "subject": "string (required, default: 'No Subject')",
    "date": "string (ISO 8601 format, optional)",
    "body": "string (required, plain text)",
    "urls": ["string"] // array of URLs extracted from HTML
  }
}
```

## Example Payload

```json
{
  "chatJid": "123456789@g.us",
  "senderName": "OpenAI",
  "email": {
    "messageId": "abc123@email.openai.com",
    "from": {
      "address": "noreply@email.openai.com",
      "name": "OpenAI"
    },
    "subject": "OpenAI Dev News: GPT-5.4, Plugins in Codex",
    "date": "2026-03-31T19:46:33+00:00",
    "body": "See what the latest models can really do...",
    "urls": [
      "https://openai.com/index/introducing-gpt-5-4/",
      "https://developers.openai.com/codex/plugins"
    ]
  }
}
```

## Forwarder Changes Required

### 1. Extract URLs from HTML parts

Add function to collect URLs from HTML MIME parts:

```python
def extract_urls_from_html(html_content):
    """Extract href URLs from HTML content"""
    urls = []
    # Find all href attributes
    for match in re.finditer(r'href=["\']([^"\']+)["\']', html_content):
        url = match.group(1)
        # Skip mailto, tel, and fragment-only links
        if not url.startswith(('#', 'mailto:', 'tel:')):
            urls.append(url)
    return urls
```

Call this when parsing HTML MIME parts in `parse_entity()`.

### 2. Build structured payload

Modify `parse_email()` to return structured data:

```python
def parse_email(raw_email):
    headers_text, _body = split_header_section(raw_email)
    message = Parser().parsestr(raw_email)
    entity = parse_entity(message, 0)

    # Get body text (prefer plain, fallback to HTML)
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

    # Extract sender info
    from_header = message.get("From", "")
    decoded = decode_mime_words(from_header).strip()
    display_name, address = parseaddr(decoded)

    # Build structured email object
    email_data = {
        "messageId": message.get("Message-ID", "").strip("<>") or None,
        "from": {
            "address": address or "unknown@unknown.com",
            "name": display_name.strip().strip('"') if display_name else None
        },
        "subject": decode_mime_words(message.get("Subject", "")) or "No Subject",
        "date": message.get("Date"),  # Keep raw date string
        "body": body_text,
        "urls": entity.get("urls", [])
    }

    return {
        "sender_name": display_name or address or "email",
        "has_attachment": entity["has_attachment"],
        "email_data": email_data
    }
```

### 3. Update payload construction in main()

```python
def main():
    endpoint = require_env("INJECT_EMAIL_URL")
    token = require_env("INJECT_SECRET")
    chat_jid = require_env("INJECT_CHAT_JID")
    sender_name = os.environ.get("INJECT_EMAIL_SENDER_NAME")

    raw_email = sys.stdin.read()
    parsed = parse_email(raw_email)

    if parsed["has_attachment"]:
        message_id = parsed["email_data"]["messageId"] or "unknown"
        print(
            "discarded email %s: attachments not supported" % message_id,
            file=sys.stderr,
        )
        return 2

    payload = {
        "chatJid": chat_jid,
        "senderName": sender_name or parsed["sender_name"],
        "email": parsed["email_data"]
    }

    # ... rest of POST logic unchanged
```

### 4. Update parse_entity() to collect URLs

Add URL collection to the recursive parser:

```python
def parse_entity(message, depth):
    if depth > MAX_MIME_DEPTH:
        return {"text_plain": [], "text_html": [], "urls": [], "has_attachment": True}

    if message.is_multipart():
        merged = {"text_plain": [], "text_html": [], "urls": [], "has_attachment": False}
        for child in message.get_payload():
            child_result = parse_entity(child, depth + 1)
            merged["text_plain"].extend(child_result["text_plain"])
            merged["text_html"].extend(child_result["text_html"])
            merged["urls"].extend(child_result["urls"])
            merged["has_attachment"] = (
                merged["has_attachment"] or child_result["has_attachment"]
            )
        return merged

    # ... existing content-type parsing ...

    if content_type == "text/html":
        urls = extract_urls_from_html(decoded_body)
        return {
            "text_plain": [],
            "text_html": [html_to_text(decoded_body)],
            "urls": urls,
            "has_attachment": False,
        }

    # ... rest of function updated to include "urls": [] in all return statements
```

## Receiver Changes Required

New processor that accepts JSON input via stdin:

```python
#!/usr/bin/env python3
"""
Email Processor v4 - JSON input from forwarder
Receives structured email data, no reparsing needed
"""

import sqlite3
import sys
import json
from datetime import datetime

DB_PATH = '/workspace/group/email_inbox.db'

def calculate_relevance(subject, from_address, body):
    """Score email relevance (0-100)"""
    score = 0

    # High priority senders
    high_priority = ['pragmaticengineer', 'bloomberg']
    if any(sender in from_address.lower() for sender in high_priority):
        score += 40

    # Keywords in subject
    keywords = ['critical', 'urgent', 'action required', 'security']
    subject_lower = subject.lower()
    if any(kw in subject_lower for kw in keywords):
        score += 30

    # Heuristics for newsletters vs transactional
    if 'unsubscribe' in body.lower():
        score -= 20

    return max(0, min(100, score))

def store_email(email_data):
    """Store structured email in database"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    # Extract fields
    message_id = email_data.get('messageId') or ''
    from_info = email_data.get('from', {})
    from_name = from_info.get('name') or from_info.get('address')
    from_address = from_info.get('address')
    subject = email_data.get('subject', 'No Subject')
    body = email_data.get('body', '')
    urls = email_data.get('urls', [])

    # Calculate relevance
    relevance = calculate_relevance(subject, from_address, body)

    # Store in database
    cursor.execute('''
        INSERT INTO emails (message_id, from_address, subject, body, relevance_score, urls)
        VALUES (?, ?, ?, ?, ?, ?)
    ''', (message_id, from_address, subject, body, relevance, json.dumps(urls)))

    conn.commit()
    conn.close()

    print(f"✅ Email stored: {subject[:50]}... (relevance: {relevance})")

def main():
    # Read JSON from stdin
    input_data = sys.stdin.read()
    payload = json.loads(input_data)

    # Extract email object
    email_data = payload.get('email')
    if not email_data:
        print("❌ No email data in payload", file=sys.stderr)
        return 1

    # Store email
    store_email(email_data)
    return 0

if __name__ == '__main__':
    sys.exit(main())
```

## Migration Strategy

### Phase 1: Forwarder Update
1. Update forwarder script to send JSON payload
2. Deploy to email relay server
3. Test with sample emails

### Phase 2: Receiver Update
1. Create new `email-processor-v4.py` with JSON parsing
2. Test locally with sample payloads
3. Swap out old processor

### Phase 3: Cleanup
1. Remove old text parsing logic
2. Update digest script if needed
3. Archive old processor as backup

## Benefits

1. **No reparsing** - Forwarder already parsed, receiver uses structured data
2. **No MIME issues** - No boundary escaping problems
3. **URLs included** - Already extracted from HTML by forwarder
4. **Clean separation** - Forwarder handles email, receiver handles storage
5. **Easier debugging** - JSON is human-readable
6. **Extensibility** - Easy to add more fields (CC, attachments metadata, etc.)

## Backward Compatibility

Old text-based payload is not preserved. This is a breaking change requiring coordinated deployment of both forwarder and receiver.

To support both during migration:
- Receiver checks if input is JSON (starts with `{`) or text (starts with `Forwarded email`)
- Falls back to old parser if text detected
- Remove fallback after migration complete
