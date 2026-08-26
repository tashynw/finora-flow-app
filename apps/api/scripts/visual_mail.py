"""Fetch the link out of an email, for the visual suite.

One screen in the platform cannot be reached from inside the platform: the page a
supplier opens to say whether a payment arrived. There is no route to it, no
button that produces it and no endpoint that will hand the token over — the token
is stored as a digest, and the only copy that exists in plaintext is the one that
went out in the email. That is the design, and it is worth keeping, so the test
gets at the page the way a supplier does: by reading the email.

Which makes this more than a convenience. A run that finds a link here has proved
the whole path end to end — the message was composed, queued, sent over SMTP,
delivered, and carries a link that works — and none of that is provable from a
screenshot of a page somebody navigated to directly.

Development only, and pointedly so. It empties a mailbox and drains a real queue,
neither of which is a thing to do to a running deployment, so it refuses outside
development and refuses against any database but the visual one.
"""

from __future__ import annotations

import argparse
import email
import imaplib
import os
import re
import sys
import time
from email.message import Message

from finora.config import Environment, Settings, get_settings

#: The only database this may be pointed at. The drain sends real mail for every
#: row it finds, and the development queue holds messages addressed to people.
VISUAL_DB = "finora_visual"

#: The supplier's link, wherever it sits in the body. Broad on the host because
#: the suite serves the application on a different port than development does.
LINK = re.compile(r"https?://\S+/payment-check-in/[A-Za-z0-9_\-]+")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--to", required=True, help="The mailbox to read.")
    parser.add_argument(
        "--timeout",
        type=float,
        default=20.0,
        help="Seconds to wait for the message to be delivered.",
    )
    args = parser.parse_args()

    if os.environ.get("FINORA_DB_NAME") != VISUAL_DB:
        print(f"FINORA_DB_NAME must be '{VISUAL_DB}'. Nothing was sent.", file=sys.stderr)
        return 1

    settings = get_settings()
    if settings.environment is not Environment.development:
        print(f"Refusing to drain a queue in {settings.environment}.", file=sys.stderr)
        return 1

    # Emptied before anything is sent, so a link left by an earlier run cannot be
    # mistaken for this one's. Its token died with the database that issued it,
    # and a test that picked it up would fail on the refusal page — truthfully,
    # but describing the wrong fault.
    _empty(settings, args.to)

    from finora.application.reminder_tasks import drain_outbox

    # Everything waiting, not only this message. A run reaches here with reminders
    # and sign-off requests from the earlier flows still queued, and a batch that
    # stopped short of the one being looked for would be a race that shows up as
    # an empty mailbox.
    while drain_outbox(batch_size=50).had_work:
        pass

    link = _await_link(settings, args.to, timeout=args.timeout)
    if link is None:
        print(f"No supplier link reached {args.to}.", file=sys.stderr)
        return 1

    # Stdout is only the link. The drain and the IMAP client log as they work,
    # and a caller that took the whole stream as the URL would navigate to a
    # multi-line string and land on the wrong page.
    sys.stdout.write(link + "\n")
    return 0


def _connect(settings: Settings, address: str) -> imaplib.IMAP4:
    """Open the named mailbox.

    Authentication is disabled on the development mail server, which is what makes
    reading a supplier's mailbox possible at all: the address is the account, and
    the password is not checked.

    Retries a transient EOF on connect. Greenmail under Docker Desktop sometimes
    accepts the TCP handshake and then drops the welcome banner after a long idle
    period; one reconnect is enough once the container is awake.
    """
    imap = settings.imap
    last_error: Exception | None = None
    for attempt in range(3):
        client: imaplib.IMAP4 | None = None
        try:
            if imap.use_tls:
                client = imaplib.IMAP4_SSL(imap.host, imap.port)
            else:
                client = imaplib.IMAP4(imap.host, imap.port)
            client.login(address, address)
            client.select("INBOX")
            return client
        except (imaplib.IMAP4.abort, imaplib.IMAP4.error, OSError) as error:
            last_error = error
            if client is not None:
                try:
                    client.logout()
                except Exception:
                    pass
            time.sleep(0.5 * (attempt + 1))
    assert last_error is not None
    raise last_error


def _message_ids(client: imaplib.IMAP4) -> list[str]:
    """Everything in the open mailbox, oldest first."""
    _, data = client.search(None, "ALL")
    first = data[0]
    if not isinstance(first, bytes):
        return []
    return [item.decode("ascii") for item in first.split()]


def _empty(settings: Settings, address: str) -> None:
    client = _connect(settings, address)
    try:
        ids = _message_ids(client)
        if ids:
            client.store(",".join(ids), "+FLAGS", "\\Deleted")
            client.expunge()
    finally:
        client.logout()


def _await_link(settings: Settings, address: str, *, timeout: float) -> str | None:
    """Poll until a message carrying a supplier link arrives, or give up.

    Polled rather than waited on, because delivery is a separate process from the
    send and the gap between them is small but real.
    """
    deadline = time.monotonic() + timeout
    while True:
        found = _read_link(settings, address)
        if found is not None:
            return found
        if time.monotonic() >= deadline:
            return None
        time.sleep(0.5)


def _read_link(settings: Settings, address: str) -> str | None:
    client = _connect(settings, address)
    try:
        # Newest first: a supplier asked twice holds the most recent link, and the
        # earlier one has been revoked.
        for message_id in reversed(_message_ids(client)):
            _, payload = client.fetch(message_id, "(RFC822)")
            raw = payload[0][1] if payload and isinstance(payload[0], tuple) else None
            if raw is None:
                continue
            match = LINK.search(_body(email.message_from_bytes(raw)))
            if match is not None:
                return match.group(0)
        return None
    finally:
        client.logout()


def _body(message: Message) -> str:
    """The plain text of a message, however it was assembled."""
    if not message.is_multipart():
        payload = message.get_payload(decode=True)
        return payload.decode("utf-8", "replace") if isinstance(payload, bytes) else ""

    parts: list[str] = []
    for part in message.walk():
        if part.get_content_type() != "text/plain":
            continue
        payload = part.get_payload(decode=True)
        if isinstance(payload, bytes):
            parts.append(payload.decode("utf-8", "replace"))
    return "\n".join(parts)


if __name__ == "__main__":
    sys.exit(main())
