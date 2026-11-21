"""Shared IPC serialization and MessagePack protocol for NaNofuzz Python runner hosts.

Provides the single source of truth for converting Python objects to/from the
wire protocol expected by NaNofuzz's TypeScript JSONN engine.
"""

import os
import sys
import uuid
from typing import Any

import msgpack

PlaceHolderValueKey = "____JSONN____61581952310____VALUE____"
PlaceHolderBigIntKey = "____JSONN____61581952310____BIGINT____"
PlaceHolderUint8ArrayKey = "____JSONN____61581952310____UINT8ARRAY____"
PlaceHolderMapKey = "____JSONN____61581952310____MAP____"
PlaceHolderSetKey = "____JSONN____61581952310____SET____"
UndefinedValue = "__undefined__"


def unwrap_jsonn(val: Any) -> Any:
    """Recursively converts JSONN wire representations into native Python values."""
    if isinstance(val, dict):
        if val.get(PlaceHolderValueKey) == UndefinedValue:
            return None
        if PlaceHolderBigIntKey in val:
            return int(val[PlaceHolderBigIntKey])
        if PlaceHolderUint8ArrayKey in val:
            return bytes(val[PlaceHolderUint8ArrayKey])
        if PlaceHolderMapKey in val:
            raw_entries = val[PlaceHolderMapKey]
            if isinstance(raw_entries, list):
                return {
                    unwrap_jsonn(k): unwrap_jsonn(v)
                    for entry in raw_entries
                    if isinstance(entry, list) and len(entry) == 2
                    for k, v in [entry]
                }
            return {}
        if PlaceHolderSetKey in val:
            raw_values = val[PlaceHolderSetKey]
            if isinstance(raw_values, list):
                return [unwrap_jsonn(x) for x in raw_values]
            return []
        return {k: unwrap_jsonn(v) for k, v in val.items()}
    if isinstance(val, list):
        return [unwrap_jsonn(x) for x in val]
    return val


def sanitize_output(obj: Any) -> Any:
    """Recursively converts Python objects into MessagePack-safe representations.

    Bytes are transformed to byte lists, sets/tuples to lists, and dict keys to strings.
    """
    if isinstance(obj, (bytes, bytearray)):
        return list(obj)
    if isinstance(obj, (set, frozenset, tuple, list)):
        return [sanitize_output(x) for x in obj]
    if isinstance(obj, uuid.UUID):
        return str(obj)
    if isinstance(obj, dict):
        res = {}
        for k, v in obj.items():
            s_k = sanitize_output(k)
            if isinstance(s_k, list):
                s_k = str(s_k)
            elif not isinstance(s_k, (str, int, float, bool)) and s_k is not None:
                s_k = str(s_k)
            res[s_k] = sanitize_output(v)
        return res
    return obj


def default_serializer(obj: Any) -> Any:
    """Fallback serializer for msgpack for types that require custom conversion."""
    if isinstance(obj, (bytes, bytearray)):
        return list(obj)
    if isinstance(obj, (set, frozenset)):
        return list(obj)
    if isinstance(obj, uuid.UUID):
        return str(obj)
    return repr(obj)


def pack_payload(data: Any) -> bytes:
    """Serializes data to MessagePack bytes using the standard NaNofuzz serializer."""
    return msgpack.packb(data, default=default_serializer, use_bin_type=True)


def unpack_payload(payload: bytes) -> Any:
    """Unpacks MessagePack bytes and revives JSONN custom types."""
    raw = msgpack.unpackb(payload, raw=False)
    return unwrap_jsonn(raw)
