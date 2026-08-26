"""Encrypted object repository.

Three properties matter here and are enforced rather than assumed:

Originals are immutable. A raw message is written once, under a key derived from
its own content hash, and the bucket carries object-lock and versioning. If a
later process tries to overwrite it, the write is refused instead of silently
replacing the evidence an auditor would rely on.

Everything is encrypted at rest, requested explicitly on every put so that a
bucket-level default going missing does not quietly produce plaintext objects.

Nothing is served directly. Reads are handed out as short-lived signed URLs,
scoped to one object, so a leaked link expires rather than granting standing
access to the document store.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from functools import lru_cache
from typing import TYPE_CHECKING, Any, Final, Literal

import boto3
from botocore.client import Config as BotoConfig
from botocore.exceptions import BotoCoreError, ClientError

from finora.config import ObjectStoreSettings, get_settings

if TYPE_CHECKING:
    from mypy_boto3_s3.client import S3Client
else:
    S3Client = Any


class Bucket(StrEnum):
    """Logical buckets. Separation is a containment boundary, not tidiness.

    Quarantined content lives apart from releasable documents so a mistake in a
    key prefix cannot expose an infected file through a document URL.
    """

    raw_messages = "raw_messages"
    documents = "documents"
    quarantine = "quarantine"
    exports = "exports"


class ObjectStoreError(Exception):
    """Storage failure that must stop the operation.

    Never swallowed: a document that was not stored must not be recorded as
    stored, or the workspace will show evidence that cannot be opened.
    """


class ImmutableObjectError(ObjectStoreError):
    """An attempt to overwrite an object that is write-once."""


_SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")

#: Server-side encryption. AES256 is SSE-S3, supported by MinIO and by S3
#: itself. A KMS key can be supplied instead in a deployment that has one.
_SSE_ALGORITHM: Final[Literal["AES256"]] = "AES256"


@dataclass(frozen=True, slots=True)
class StoredObject:
    bucket: Bucket
    key: str
    size_bytes: int
    sha256: str
    content_type: str
    stored_at: datetime
    #: Set when the bucket has versioning enabled, which pins this exact write.
    version_id: str | None = None


def raw_message_key(*, received_at: datetime, raw_sha256: str) -> str:
    """Key for an immutable raw message.

    Derived from the content hash, so the same message always maps to the same
    key and a duplicate write is detectable rather than destructive. The date
    prefix keeps listings and lifecycle rules workable.
    """
    if not _SHA256_HEX.match(raw_sha256):
        raise ValueError("raw_sha256 must be 64 lower-case hexadecimal characters.")
    day = received_at.astimezone(UTC).strftime("%Y/%m/%d")
    return f"messages/{day}/{raw_sha256}.eml"


def attachment_key(*, message_id: str, sha256: str, filename: str) -> str:
    """Key for a stored attachment.

    The filename is appended for human recognition only. It is already sanitised
    by intake policy, and the hash is what makes the key unique, so a hostile
    filename cannot influence where the object lands.
    """
    if not _SHA256_HEX.match(sha256):
        raise ValueError("sha256 must be 64 lower-case hexadecimal characters.")
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", filename)[:80] or "attachment"
    return f"attachments/{message_id}/{sha256}/{safe}"


class ObjectStore:
    """S3-compatible storage adapter."""

    def __init__(self, settings: ObjectStoreSettings, client: S3Client | None = None):
        self._settings = settings
        self._client = client or _build_client(settings)

    def bucket_name(self, bucket: Bucket) -> str:
        mapping = {
            Bucket.raw_messages: self._settings.bucket_raw,
            Bucket.documents: self._settings.bucket_documents,
            Bucket.quarantine: self._settings.bucket_quarantine,
            Bucket.exports: self._settings.bucket_exports,
        }
        return mapping[bucket]

    # ------------------------------------------------------------------ writes

    def put(
        self,
        *,
        bucket: Bucket,
        key: str,
        data: bytes,
        content_type: str,
        sha256: str,
        metadata: dict[str, str] | None = None,
    ) -> StoredObject:
        """Store an object, encrypted, and confirm what was written."""
        if not _SHA256_HEX.match(sha256):
            raise ValueError("sha256 must be 64 lower-case hexadecimal characters.")

        try:
            response = self._client.put_object(
                Bucket=self.bucket_name(bucket),
                Key=key,
                Body=data,
                ContentType=content_type,
                ServerSideEncryption=_SSE_ALGORITHM,
                # Checksum is verified by the service, so a truncated or altered
                # upload is rejected at the boundary rather than discovered later
                # when someone tries to open the document.
                ChecksumAlgorithm="SHA256",
                Metadata={
                    "sha256": sha256,
                    **(metadata or {}),
                },
            )
        except (ClientError, BotoCoreError) as error:
            raise ObjectStoreError(
                f"Could not store object '{key}'. Nothing was recorded as stored."
            ) from error

        return StoredObject(
            bucket=bucket,
            key=key,
            size_bytes=len(data),
            sha256=sha256,
            content_type=content_type,
            stored_at=datetime.now(UTC),
            version_id=response.get("VersionId"),
        )

    def put_immutable(
        self,
        *,
        bucket: Bucket,
        key: str,
        data: bytes,
        content_type: str,
        sha256: str,
        metadata: dict[str, str] | None = None,
    ) -> StoredObject:
        """Store an object that must never be replaced.

        If the key already holds different content, the write is refused. If it
        holds identical content, the existing object is returned, because a
        retried ingest of the same message is expected and is not an error.
        """
        existing = self.head(bucket=bucket, key=key)
        if existing is not None:
            if existing.sha256 == sha256:
                return existing
            raise ImmutableObjectError(
                f"Object '{key}' already exists with different content. "
                "Stored originals are never replaced."
            )

        return self.put(
            bucket=bucket,
            key=key,
            data=data,
            content_type=content_type,
            sha256=sha256,
            metadata=metadata,
        )

    # ------------------------------------------------------------------- reads

    def head(self, *, bucket: Bucket, key: str) -> StoredObject | None:
        try:
            response = self._client.head_object(Bucket=self.bucket_name(bucket), Key=key)
        except ClientError as error:
            code = error.response.get("Error", {}).get("Code", "")
            if code in {"404", "NoSuchKey", "NotFound"}:
                return None
            raise ObjectStoreError(f"Could not read metadata for '{key}'.") from error
        except BotoCoreError as error:
            raise ObjectStoreError(f"Could not read metadata for '{key}'.") from error

        metadata = response.get("Metadata") or {}
        return StoredObject(
            bucket=bucket,
            key=key,
            size_bytes=int(response.get("ContentLength", 0)),
            sha256=metadata.get("sha256", ""),
            content_type=response.get("ContentType", "application/octet-stream"),
            stored_at=response.get("LastModified") or datetime.now(UTC),
            version_id=response.get("VersionId"),
        )

    def get(self, *, bucket: Bucket, key: str, expected_sha256: str | None = None) -> bytes:
        """Fetch an object, optionally verifying it is byte-for-byte what was stored."""
        try:
            response = self._client.get_object(Bucket=self.bucket_name(bucket), Key=key)
            body = response["Body"].read()
        except (ClientError, BotoCoreError) as error:
            raise ObjectStoreError(f"Could not retrieve object '{key}'.") from error

        if expected_sha256 is not None:
            actual = hashlib.sha256(body).hexdigest()
            if actual != expected_sha256:
                # Either the stored bytes changed or the wrong object was
                # returned. Both mean the evidence chain is broken, so the caller
                # must not be handed the content.
                raise ObjectStoreError(
                    f"Object '{key}' does not match its recorded hash. It has not been returned."
                )

        return body

    def signed_url(
        self,
        *,
        bucket: Bucket,
        key: str,
        download_filename: str | None = None,
        expires_in: int | None = None,
    ) -> str:
        """A short-lived URL for one object.

        Quarantined content is never given a URL. A file that failed scanning
        must not be reachable by anyone following a link, however that link was
        obtained.
        """
        if bucket is Bucket.quarantine:
            raise ObjectStoreError(
                "Quarantined content cannot be served. Release it for review "
                "through the quarantine workflow instead."
            )

        params: dict[str, Any] = {"Bucket": self.bucket_name(bucket), "Key": key}
        if download_filename:
            # `attachment` prevents the browser from rendering the file in the
            # page, which is what turns an uploaded HTML or SVG file into stored
            # cross-site scripting.
            params["ResponseContentDisposition"] = (
                f'attachment; filename="{_header_safe(download_filename)}"'
            )

        try:
            return self._client.generate_presigned_url(
                "get_object",
                Params=params,
                ExpiresIn=expires_in or self._settings.signed_url_ttl_seconds,
            )
        except (ClientError, BotoCoreError) as error:
            raise ObjectStoreError(f"Could not create a link for '{key}'.") from error

    # ------------------------------------------------------------------ health

    def ping(self) -> None:
        """Confirm the store is reachable and the required buckets exist."""
        for bucket in Bucket:
            name = self.bucket_name(bucket)
            try:
                self._client.head_bucket(Bucket=name)
            except (ClientError, BotoCoreError) as error:
                raise ObjectStoreError(f"Bucket '{name}' is not available.") from error


def _header_safe(value: str) -> str:
    """Strip anything that could break out of a Content-Disposition header."""
    return re.sub(r"[^\w .\-()]", "_", value)[:100] or "download"


def _build_client(settings: ObjectStoreSettings) -> S3Client:
    return boto3.client(
        "s3",
        endpoint_url=settings.endpoint_url,
        region_name=settings.region,
        aws_access_key_id=settings.access_key.get_secret_value() or None,
        aws_secret_access_key=settings.secret_key.get_secret_value() or None,
        config=BotoConfig(
            signature_version="s3v4",
            # MinIO and most S3-compatible stores need path addressing.
            s3={"addressing_style": "path"},
            retries={"max_attempts": 3, "mode": "standard"},
            connect_timeout=5,
            read_timeout=30,
        ),
    )


@lru_cache(maxsize=1)
def get_object_store() -> ObjectStore:
    return ObjectStore(get_settings().object_store)
