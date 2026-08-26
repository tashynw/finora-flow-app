"""Application configuration.

Every value arrives from the environment. No secret carries a usable default,
so a misconfigured deployment fails at startup rather than silently running with
a well-known credential.
"""

from __future__ import annotations

from enum import StrEnum
from functools import lru_cache

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Environment(StrEnum):
    development = "development"
    test = "test"
    pilot = "pilot"
    production = "production"


class _EnvSettings(BaseSettings):
    """Shared loading behaviour.

    Pydantic merges `model_config` down the class hierarchy, so subclasses add
    only their own `env_prefix`. The `.env` file is a development convenience;
    in production the environment is populated from the secret store and no
    `.env` file is present.
    """

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")


class DatabaseSettings(_EnvSettings):
    model_config = SettingsConfigDict(env_prefix="FINORA_DB_", extra="ignore")

    host: str = "localhost"
    port: int = 5432
    user: str = "finora"
    password: SecretStr = SecretStr("")
    name: str = "finora"
    pool_size: int = 10
    max_overflow: int = 5

    @property
    def dsn(self) -> str:
        pwd = self.password.get_secret_value()
        return f"postgresql+psycopg://{self.user}:{pwd}@{self.host}:{self.port}/{self.name}"


class RedisSettings(_EnvSettings):
    model_config = SettingsConfigDict(env_prefix="FINORA_REDIS_", extra="ignore")

    host: str = "localhost"
    port: int = 6379
    password: SecretStr = SecretStr("")
    db: int = 0

    @property
    def dsn(self) -> str:
        pwd = self.password.get_secret_value()
        auth = f":{pwd}@" if pwd else ""
        return f"redis://{auth}{self.host}:{self.port}/{self.db}"


class ObjectStoreSettings(_EnvSettings):
    """S3-compatible storage for immutable originals and derived documents."""

    model_config = SettingsConfigDict(env_prefix="FINORA_S3_", extra="ignore")

    endpoint_url: str | None = None
    region: str = "us-east-1"
    access_key: SecretStr = SecretStr("")
    secret_key: SecretStr = SecretStr("")
    bucket_raw: str = "finora-raw-messages"
    bucket_documents: str = "finora-documents"
    bucket_quarantine: str = "finora-quarantine"
    bucket_exports: str = "finora-exports"
    # Signed download URLs are deliberately short-lived.
    signed_url_ttl_seconds: int = 300


class ImapSettings(_EnvSettings):
    """Inbound mail. Provider-neutral: the platform only ever reads the
    controlled mailbox that receives forwarded copies."""

    model_config = SettingsConfigDict(env_prefix="FINORA_IMAP_", extra="ignore")

    host: str = "localhost"
    port: int = 993
    use_tls: bool = True
    verify_certificate: bool = True
    username: str = ""
    password: SecretStr = SecretStr("")
    use_oauth2: bool = False

    # Two destinations only. Scanning happens inside the ingest transaction, so a
    # message is never in an intermediate "being scanned" state that a third
    # folder would represent. A quarantined attachment sends its message to
    # Exception; quarantine itself is a storage bucket, not a mailbox folder,
    # because the infected bytes must leave the mailbox to be held safely.
    folder_inbox: str = "INBOX"
    folder_processed: str = "Finora/Processed"
    folder_exception: str = "Finora/Exception"

    poll_interval_seconds: int = 60
    use_idle: bool = False
    batch_size: int = 25


class SmtpSettings(_EnvSettings):
    model_config = SettingsConfigDict(env_prefix="FINORA_SMTP_", extra="ignore")

    host: str = "localhost"
    port: int = 587
    use_starttls: bool = True
    use_implicit_tls: bool = False
    verify_certificate: bool = True
    username: str = ""
    password: SecretStr = SecretStr("")
    from_address: str = "finora@example.invalid"
    from_display_name: str = "Finora Flow"
    max_send_attempts: int = 5

    #: Where external mail invites replies, before the per-conversation tag is
    #: inserted into it. Separate from `from_address` because it must be the
    #: mailbox the IMAP worker actually polls, and must accept sub-addressed
    #: mail — `payments+fnr….@example.com` has to reach `payments@example.com`.
    #: Empty falls back to `from_address`, which is right for the common
    #: deployment where they are the same mailbox.
    reply_to_address: str = ""


class ScannerSettings(_EnvSettings):
    model_config = SettingsConfigDict(env_prefix="FINORA_SCANNER_", extra="ignore")

    host: str = "localhost"
    port: int = 3310
    timeout_seconds: int = 60
    max_attachment_bytes: int = 25 * 1024 * 1024
    max_archive_entries: int = 500
    max_archive_expansion_ratio: int = 100
    max_document_pages: int = 500
    # A missing scanner must never be treated as a clean result.
    fail_closed: bool = True


class AiSettings(_EnvSettings):
    """AI Gateway. Local by default; business modules never reach a provider
    directly and the gateway holds no mail credentials."""

    model_config = SettingsConfigDict(env_prefix="FINORA_AI_", extra="ignore")

    enabled: bool = True
    base_url: str = "http://localhost:11434/v1"
    api_key: SecretStr = SecretStr("")
    model_extraction: str = "qwen2.5vl:7b"
    model_classification: str = "qwen2.5:7b"
    request_timeout_seconds: int = 120
    max_attempts: int = 2
    # Global kill switch. When tripped, every workflow must remain completable
    # by hand.
    kill_switch_engaged: bool = False
    circuit_breaker_failure_threshold: int = 5
    circuit_breaker_reset_seconds: int = 120


class ExtractionSettings(_EnvSettings):
    """Reading documents: where trust ends and a person begins.

    The thresholds live here rather than beside the AI settings because they
    govern every reading, including the ones no model touched. A rule that found
    a total by its position on the page is judged by the same numbers.
    """

    model_config = SettingsConfigDict(env_prefix="FINORA_EXTRACTION_", extra="ignore")

    #: At or above this a value needs no second pair of eyes. Tuned against real
    #: documents; raising it costs review time, lowering it costs correctness.
    review_confidence_threshold: float = 0.85
    #: Below this a value is shown as a hint and nothing more.
    low_confidence_threshold: float = 0.55
    #: Pages searched for values. Later pages remain viewable.
    max_read_pages: int = 10
    max_read_seconds: float = 20.0
    #: Documents one pass of the reader takes. Bounded so a large backlog is
    #: worked through in steady increments rather than one long transaction.
    batch_size: int = 10


class AuthSettings(_EnvSettings):
    model_config = SettingsConfigDict(env_prefix="FINORA_AUTH_", extra="ignore")

    oidc_issuer: str = ""
    oidc_client_id: str = ""
    oidc_client_secret: SecretStr = SecretStr("")
    oidc_audience: str = ""
    oidc_scopes: str = "openid profile email"
    jwks_cache_seconds: int = 3600
    session_cookie_name: str = "finora_session"
    session_ttl_seconds: int = 8 * 3600
    # Signs sign-off and vendor confirmation deep links.
    link_signing_key: SecretStr = SecretStr("")
    link_ttl_seconds: int = 14 * 24 * 3600
    # Off by default; enabling requires explicit security approval.
    allow_local_accounts: bool = False


class WorkflowSettings(_EnvSettings):
    """Policy thresholds. These are configuration, not constants, because the
    authoritative requirements document is not yet available."""

    model_config = SettingsConfigDict(env_prefix="FINORA_WORKFLOW_", extra="ignore")

    base_currency: str = "JMD"
    display_timezone: str = "America/Jamaica"
    # Master prompt: PO controls apply above JMD 50,000 initially.
    po_required_threshold_minor_units: int = 50_000_00
    # Master prompt: three-hour reminder and escalation cycle.
    reminder_interval_hours: int = 3
    reminder_max_count: int = 8
    # Reminders at one level before the next person up is copied in. Escalation
    # adds a recipient; it never replaces the one who still holds the task.
    reminder_escalate_every: int = 3
    reminder_max_escalation_level: int = 3
    business_hours_start: int = 8
    business_hours_end: int = 17
    business_days: str = "MON,TUE,WED,THU,FRI"
    suppress_outside_business_hours: bool = True

    # How far an invoice may exceed an approved estimate or a purchase order
    # before it needs deciding again. Both allowances apply and the larger wins,
    # because a percentage is useless on a small invoice and an absolute figure is
    # either meaningless or reckless depending on the size. Zero by default: an
    # approval is a limit until somebody with authority says otherwise, and a
    # tolerance invented here would be that decision made by a programmer.
    invoice_tolerance_percent: int = 0
    invoice_tolerance_minor_units: int = 0

    # How long a sign-off deep link stays usable. Shorter than the generic link
    # lifetime because a sign-off is the one link that reaches a screen where
    # money can be set moving, and a stale one in a mailbox is a liability.
    sign_off_link_ttl_hours: int = 72

    # Asking a supplier whether our payment reached them. Every number here is
    # slower and smaller than its internal counterpart above, because the person
    # on the other end is not our colleague: they are doing us a favour, about a
    # payment we may have failed to make, and chasing them every three hours
    # would land the platform's mail in a spam folder — after which the messages
    # that matter go there too.
    vendor_check_in_interval_days: int = 5
    vendor_check_in_max_follow_ups: int = 3
    # Across every check-in one supplier is party to, not per check-in. A
    # month-end run touching forty of their invoices must not arrive as forty
    # emails.
    vendor_daily_mail_limit: int = 2
    # A month rather than three days, because the page a supplier's link opens
    # records a claim and takes no action. See ADR 9.
    vendor_check_in_link_ttl_hours: int = 720


class Settings(_EnvSettings):
    model_config = SettingsConfigDict(env_prefix="FINORA_", extra="ignore")

    environment: Environment = Environment.development
    debug: bool = False
    app_name: str = "Finora Flow"
    api_prefix: str = "/api/v1"
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173"])
    #: Where the browser application is served from, for building the deep links
    #: that go into email. Configuration rather than derived from the request,
    #: because a link built from an attacker-supplied Host header would send the
    #: recipient somewhere of the attacker's choosing.
    web_base_url: str = "http://localhost:5173"

    database: DatabaseSettings = Field(default_factory=DatabaseSettings)
    redis: RedisSettings = Field(default_factory=RedisSettings)
    object_store: ObjectStoreSettings = Field(default_factory=ObjectStoreSettings)
    imap: ImapSettings = Field(default_factory=ImapSettings)
    smtp: SmtpSettings = Field(default_factory=SmtpSettings)
    scanner: ScannerSettings = Field(default_factory=ScannerSettings)
    ai: AiSettings = Field(default_factory=AiSettings)
    extraction: ExtractionSettings = Field(default_factory=ExtractionSettings)
    auth: AuthSettings = Field(default_factory=AuthSettings)
    workflow: WorkflowSettings = Field(default_factory=WorkflowSettings)

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [item.strip() for item in value.split(",") if item.strip()]
        return value

    @property
    def is_production(self) -> bool:
        return self.environment is Environment.production

    def assert_production_ready(self) -> None:
        """Refuse to serve production traffic with development placeholders.

        Called during startup so a missing secret is a boot failure rather than
        a runtime surprise on a financial action.
        """
        if not self.is_production:
            return

        missing: list[str] = []
        if not self.database.password.get_secret_value():
            missing.append("FINORA_DB_PASSWORD")
        if not self.auth.oidc_issuer:
            missing.append("FINORA_AUTH_OIDC_ISSUER")
        if not self.auth.oidc_client_id:
            missing.append("FINORA_AUTH_OIDC_CLIENT_ID")
        if not self.auth.link_signing_key.get_secret_value():
            missing.append("FINORA_AUTH_LINK_SIGNING_KEY")
        if not self.object_store.secret_key.get_secret_value():
            missing.append("FINORA_S3_SECRET_KEY")
        if missing:
            raise RuntimeError(
                "Refusing to start in production without: " + ", ".join(sorted(missing))
            )

        if self.auth.allow_local_accounts:
            raise RuntimeError(
                "Local password accounts must not be enabled in production "
                "without an approved security exception."
            )
        if self.debug:
            raise RuntimeError("Debug mode must be disabled in production.")
        if not self.scanner.fail_closed:
            raise RuntimeError("Malware scanning must fail closed in production.")


@lru_cache
def get_settings() -> Settings:
    return Settings()
