"""Sending one message over SMTP.

The only place in the platform that talks to a mail server for outbound mail, and
deliberately the dullest module in it: build a message, open a connection, send,
close. Everything interesting — whether to send, to whom, how often, what happens
when it fails — is decided before this code is reached.

Plain text only. An HTML body would mean deciding how to escape record data into
markup, and a mistake there sends a supplier's name into somebody's mail client as
markup. There is nothing in a reminder that needs formatting badly enough to take
that on.
"""

from __future__ import annotations

import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, formatdate

import structlog

from finora.config import SmtpSettings
from finora.infrastructure.db.models import OutboxMessage

logger = structlog.get_logger(__name__)


class MailerError(Exception):
    """The message could not be handed to the mail server."""


def build_message(message: OutboxMessage, *, settings: SmtpSettings) -> EmailMessage:
    """Turn a queued row into an RFC 5322 message.

    The `Message-ID` is the one generated when the row was written rather than one
    the mail server invents, so a reply quoting it can be correlated back to this
    record. That correlation is why the column is unique.

    `Auto-Submitted` is set on every message. It is what tells a well-behaved
    mail system not to answer, and an automatic reply to a reminder produces a new
    inbound message, which produces another reminder, which is a loop this
    platform would otherwise pay for.

    `Reply-To` appears only on mail leaving the organisation, where it carries a
    tag identifying the conversation. It is what rescues a reply from a client
    that dropped the threading headers, or one forwarded through a shared inbox
    and sent on by hand.
    """
    email = EmailMessage()
    email["From"] = formataddr((settings.from_display_name, settings.from_address))
    email["To"] = formataddr((message.to_name, message.to_address))
    if message.cc_addresses:
        email["Cc"] = ", ".join(message.cc_addresses)
    if message.reply_to_address:
        email["Reply-To"] = message.reply_to_address
    email["Subject"] = message.subject
    email["Message-ID"] = message.message_id
    email["Date"] = formatdate(localtime=True)
    if message.in_reply_to:
        email["In-Reply-To"] = message.in_reply_to
        email["References"] = message.in_reply_to
    email["Auto-Submitted"] = "auto-generated"
    email["X-Auto-Response-Suppress"] = "All"
    email.set_content(message.body_text)
    return email


class SmtpMailer:
    """Authenticated SMTP, with TLS required unless explicitly disabled."""

    def __init__(self, settings: SmtpSettings) -> None:
        self._settings = settings

    def send(self, message: OutboxMessage) -> None:
        settings = self._settings
        email = build_message(message, settings=settings)

        # The envelope list is built explicitly rather than left to `send_message`
        # to derive from headers, so a Cc added by escalation is definitely
        # delivered and a header that somehow carried a stray address is not.
        envelope = [message.to_address, *message.cc_addresses]

        try:
            with self._connect() as client:
                if settings.username:
                    client.login(settings.username, settings.password.get_secret_value())
                client.send_message(email, from_addr=settings.from_address, to_addrs=envelope)
        except (smtplib.SMTPException, OSError, ssl.SSLError) as error:
            # Wrapped so the drain sees one exception type from every transport
            # failure, and so a stack trace from deep inside smtplib does not
            # become the error text an operator reads.
            raise MailerError(f"{type(error).__name__}: {error}") from error

        logger.debug("mailer.sent", message_id=message.message_id, to=message.to_address)

    def _connect(self) -> smtplib.SMTP:
        settings = self._settings
        context = ssl.create_default_context()
        if not settings.verify_certificate:
            # Development against a local test server with a self-signed
            # certificate. Production readiness checks refuse this combination.
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE

        if settings.use_implicit_tls:
            return smtplib.SMTP_SSL(settings.host, settings.port, timeout=30, context=context)

        client = smtplib.SMTP(settings.host, settings.port, timeout=30)
        if settings.use_starttls:
            client.starttls(context=context)
        return client
