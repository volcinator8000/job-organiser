"""Encrypted SQLite vault shared with the web app and jobctl.

File format (all integers big-endian):

    offset  size  field
    0       8     magic  b"JOBVAULT"
    8       1     version (1)
    9       4     PBKDF2 iterations
    13      16    salt
    29      12    AES-GCM nonce
    41      ...   AES-256-GCM ciphertext of the SQLite file, followed by the 16-byte tag

The key is PBKDF2-HMAC-SHA256(password, salt, iterations). The 41-byte header
is authenticated as associated data, so it cannot be tampered with either.
"""

from __future__ import annotations

import os
import sqlite3
import struct
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

MAGIC = b"JOBVAULT"
VERSION = 1
ITERATIONS = 600_000
HEADER = struct.Struct(">8sBI16s12s")
SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema.sql"


class VaultError(Exception):
    pass


def derive_key(password: str, salt: bytes, iterations: int) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iterations)
    return kdf.derive(password.encode("utf-8"))


def encrypt(plain: bytes, password: str, *, salt: bytes | None = None,
            iterations: int = ITERATIONS) -> bytes:
    salt = salt or os.urandom(16)
    nonce = os.urandom(12)
    header = HEADER.pack(MAGIC, VERSION, iterations, salt, nonce)
    key = derive_key(password, salt, iterations)
    return header + AESGCM(key).encrypt(nonce, plain, header)


def decrypt(blob: bytes, password: str) -> bytes:
    if len(blob) < HEADER.size + 16:
        raise VaultError("file is too short to be a vault")
    magic, version, iterations, salt, nonce = HEADER.unpack_from(blob)
    if magic != MAGIC or version != VERSION:
        raise VaultError("not a job vault (bad magic or version)")
    header = blob[:HEADER.size]
    key = derive_key(password, salt, iterations)
    try:
        return AESGCM(key).decrypt(nonce, blob[HEADER.size:], header)
    except Exception as exc:  # InvalidTag
        raise VaultError("wrong password or corrupted vault") from exc


def apply_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))


class Vault:
    """Open a vault as an in-memory SQLite connection; plaintext never touches disk.

        with Vault.open("data/jobs.vault", password) as v:
            v.conn.execute("SELECT * FROM v_due_followups")
            v.save()   # only needed after writes
    """

    def __init__(self, path: Path, password: str, conn: sqlite3.Connection, plain: bytes):
        self.path = path
        self._password = password
        self.conn = conn
        self._plain = plain

    @classmethod
    def open(cls, path: str | os.PathLike, password: str, *, create: bool = False) -> "Vault":
        path = Path(path)
        conn = sqlite3.connect(":memory:")
        if path.exists():
            plain = decrypt(path.read_bytes(), password)
            conn.deserialize(plain)
        elif create:
            plain = b""
        else:
            raise FileNotFoundError(path)
        apply_schema(conn)
        conn.row_factory = sqlite3.Row
        return cls(path, password, conn, plain)

    def save(self) -> bool:
        """Re-encrypt and write atomically. Returns False if nothing changed."""
        self.conn.commit()
        plain = self.conn.serialize()
        if plain == self._plain:
            return False
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_bytes(encrypt(plain, self._password))
        os.replace(tmp, self.path)
        self._plain = plain
        return True

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> "Vault":
        return self

    def __exit__(self, *exc) -> None:
        self.close()
