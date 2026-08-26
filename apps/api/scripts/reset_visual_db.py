"""Rebuild the database the visual suite runs against.

Visual regression compares screenshots to committed baselines, which only works
if the data behind them is the same every run. Against the shared development
database it is not: records accumulate, so a populated screen drifts and a test
that photographs an empty queue passes or fails depending on whether some other
test happened to add a row first. Both failures are indistinguishable from a real
layout regression, which is precisely what the baselines exist to detect.

So the suite gets its own database, dropped and rebuilt here before the API
starts. It is created by migration rather than by `create_all`, so the schema
under test is the one a deployment would actually get, and a broken migration
fails here instead of in production.

Refuses to touch anything but its own database, and refuses to run outside
development, because "drop the database" is not a command that should be one
mistyped environment variable away from the real one.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from sqlalchemy import create_engine, text

API_ROOT = Path(__file__).resolve().parent.parent

#: The only database this script will drop. Deliberately not configurable.
VISUAL_DB = "finora_visual"


def main() -> int:
    # Imported here so a missing environment variable is reported by the checks
    # below rather than as an import-time traceback.
    from finora.config import Environment, get_settings

    if os.environ.get("FINORA_DB_NAME") != VISUAL_DB:
        print(
            f"FINORA_DB_NAME must be '{VISUAL_DB}' to run this. "
            f"It is {os.environ.get('FINORA_DB_NAME')!r}, so nothing was dropped."
        )
        return 1

    settings = get_settings()
    if settings.environment is not Environment.development:
        print(f"Refusing to drop a database in {settings.environment}.")
        return 1
    if settings.database.name != VISUAL_DB:
        print(f"Resolved database is {settings.database.name!r}. Nothing was dropped.")
        return 1

    db = settings.database
    password = db.password.get_secret_value()
    admin_dsn = f"postgresql+psycopg://{db.user}:{password}@{db.host}:{db.port}/postgres"

    # AUTOCOMMIT because DROP DATABASE cannot run inside a transaction.
    admin = create_engine(admin_dsn, isolation_level="AUTOCOMMIT", pool_pre_ping=True)
    with admin.connect() as connection:
        # A previous run's connections would otherwise block the drop. Only ever
        # aimed at the visual database.
        connection.execute(
            text(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                "WHERE datname = :name AND pid <> pg_backend_pid()"
            ),
            {"name": VISUAL_DB},
        )
        connection.execute(text(f'DROP DATABASE IF EXISTS "{VISUAL_DB}"'))
        connection.execute(text(f'CREATE DATABASE "{VISUAL_DB}"'))
    admin.dispose()

    for step in (
        ([sys.executable, "-m", "alembic", "upgrade", "head"], "migrate"),
        ([sys.executable, "scripts/seed_dev.py"], "seed accounts"),
    ):
        command, label = step
        # S603: the command is a literal above, and the interpreter is this one.
        result = subprocess.run(command, cwd=API_ROOT, check=False)  # noqa: S603
        if result.returncode != 0:
            print(f"Could not {label}. The visual database is not usable.")
            return result.returncode

    print(f"{VISUAL_DB} rebuilt.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
