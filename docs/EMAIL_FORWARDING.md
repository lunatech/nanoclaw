# Email Forwarding to NanoClaw

NanoClaw exposes a dedicated email ingestion endpoint at `POST /inject/email`.
`GET /inject/email` is not a health check and will not ingest mail.

This path is intended for a mail-server delivery script that:

- reads an RFC822 email from stdin
- rejects any message with attachments
- preserves the full email as normalized text
- wraps that text in `<untrusted>...</untrusted>`
- posts the payload to NanoClaw with bearer auth

## Script path

```bash
/path/to/nanoclaw/src/email-forwarder-cli.py
```

This file is a standalone `python3` script with a shebang, so you can either
execute it directly or invoke it with `python3`.

```bash
chmod +x /path/to/nanoclaw/src/email-forwarder-cli.py
```

## Required environment

```bash
INJECT_EMAIL_URL=http://127.0.0.1:3721/inject/email
INJECT_SECRET=your-bearer-token
INJECT_CHAT_JID=target-group-jid
```

Optional:

```bash
INJECT_EMAIL_SENDER_NAME=Mailbox
```

## Postfix pipe example

Use a dedicated alias or server-side filter that pipes selected mail to:

```bash
/path/to/nanoclaw/src/email-forwarder-cli.py
```

If the host does not honor the shebang, call it explicitly:

```bash
python3 /path/to/nanoclaw/src/email-forwarder-cli.py
```

The script exits non-zero when:

- the email contains attachments
- the NanoClaw endpoint rejects the payload
- the HTTP request fails

Only route mail that you explicitly want NanoClaw to see. Keep the HTTP endpoint private, ideally on Tailscale or another private network.

## Manual probe

Use an authenticated `POST`, not `GET`, when checking whether the endpoint is
up:

```bash
curl -X POST \
  -H "Authorization: Bearer $INJECT_SECRET" \
  -H "Content-Type: application/json" \
  --data '{}' \
  http://127.0.0.1:3721/inject/email
```

If the server is reachable, that probe should return `400 {"error":"chatJid is
required"}` or another payload-validation error instead of `404`.

## Marker caveat

The server requires the forwarded payload to contain exactly one
`<untrusted>...</untrusted>` block.

If the normalized email text itself contains the literal strings
`<untrusted>` or `</untrusted>`, the email will be rejected instead of
forwarded. That is intentional in this version because the trust boundary is
part of the security model.
