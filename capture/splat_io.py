"""Minimal Gaussian-splat file I/O: read centres from .ply / .splat / .spz, write 3DGS .ply."""

from __future__ import annotations

import gzip
import struct
from pathlib import Path

import numpy as np

PLY_TYPES = {"float": "<f4", "float32": "<f4", "double": "<f8", "float64": "<f8", "uchar": "u1", "uint8": "u1",
             "char": "i1", "int8": "i1", "short": "<i2", "int16": "<i2", "ushort": "<u2", "uint16": "<u2",
             "int": "<i4", "int32": "<i4", "uint": "<u4", "uint32": "<u4"}
SH_C0 = 0.28209479177387814
MAX_POINTS = 250_000


def _read_ply(data: bytes) -> np.ndarray:
    end = data.find(b"end_header")
    if end < 0:
        raise ValueError("not a PLY file")
    header = data[:end].decode("ascii", "replace").splitlines()
    body_start = data.index(b"\n", end) + 1
    fmt, count, props, in_vertex = None, 0, [], False
    for line in header:
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "format":
            fmt = parts[1]
        elif parts[0] == "element":
            in_vertex = parts[1] == "vertex"
            if in_vertex:
                count = int(parts[2])
        elif parts[0] == "property" and in_vertex and parts[1] != "list":
            props.append((parts[2], PLY_TYPES[parts[1]]))
    if fmt == "ascii":
        rows = data[body_start:].decode().split("\n")[:count]
        table = np.array([[float(v) for v in row.split()[: len(props)]] for row in rows if row.strip()])
        names = [name for name, _ in props]
        xyz = table[:, [names.index("x"), names.index("y"), names.index("z")]]
        return xyz
    if fmt != "binary_little_endian":
        raise ValueError(f"unsupported PLY format {fmt}")
    vertices = np.frombuffer(data, dtype=np.dtype(props), count=count, offset=body_start)
    xyz = np.column_stack([vertices["x"], vertices["y"], vertices["z"]]).astype(np.float64)
    if "opacity" in vertices.dtype.names:  # drop nearly transparent floaters
        xyz = xyz[vertices["opacity"] > -2.0]
    return xyz


def _read_splat(data: bytes) -> np.ndarray:
    dtype = np.dtype([("pos", "<f4", 3), ("scale", "<f4", 3), ("rgba", "u1", 4), ("rot", "u1", 4)])
    records = np.frombuffer(data[: len(data) // 32 * 32], dtype=dtype)
    return records["pos"][records["rgba"][:, 3] > 40].astype(np.float64)


def _read_spz(data: bytes) -> np.ndarray:
    raw = gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data
    magic, version, count, _sh, fractional, _flags, _reserved = struct.unpack_from("<IIIBBBB", raw, 0)
    if magic != 0x5053474E:
        raise ValueError("not an SPZ file")
    offset = 16
    if version == 1:  # float16 positions
        xyz = np.frombuffer(raw, dtype="<f2", count=count * 3, offset=offset).reshape(-1, 3).astype(np.float64)
    else:
        packed = np.frombuffer(raw, dtype=np.uint8, count=count * 9, offset=offset).reshape(-1, 3, 3).astype(np.int32)
        value = packed[..., 0] | (packed[..., 1] << 8) | (packed[..., 2] << 16)
        value = np.where(value & 0x800000, value - (1 << 24), value)
        xyz = value.astype(np.float64) / (1 << fractional)
    alphas = np.frombuffer(raw, dtype=np.uint8, count=count, offset=offset + count * (6 if version == 1 else 9))
    return xyz[alphas > 25]


def read_points(path: Path) -> np.ndarray:
    data = Path(path).read_bytes()
    suffix = Path(path).suffix.lower()
    if suffix == ".ply" or data[:3] == b"ply":
        xyz = _read_ply(data)
    elif suffix == ".spz":
        xyz = _read_spz(data)
    elif suffix == ".splat":
        xyz = _read_splat(data)
    else:
        raise ValueError(f"unsupported splat format '{suffix}' (use .ply, .splat or .spz)")
    xyz = xyz[np.isfinite(xyz).all(axis=1)]
    if len(xyz) > MAX_POINTS:
        xyz = xyz[np.random.default_rng(0).choice(len(xyz), MAX_POINTS, replace=False)]
    return xyz


def write_gaussian_ply(path: Path, xyz: np.ndarray, rgb: np.ndarray, scale: np.ndarray,
                       rotation_wxyz: np.ndarray, alpha: np.ndarray) -> Path:
    """Standard 3DGS PLY (SH degree 0): loads in Spark, SuperSplat, gsplat viewers."""
    n = len(xyz)
    fields = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
              "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    table = np.zeros((n, len(fields)), np.float32)
    table[:, 0:3] = xyz
    table[:, 6:9] = (np.clip(rgb, 0, 1) - 0.5) / SH_C0
    clipped = np.clip(alpha, 1e-4, 1 - 1e-4)
    table[:, 9] = np.log(clipped / (1 - clipped))
    table[:, 10:13] = np.log(np.maximum(scale, 1e-5))
    quats = rotation_wxyz / np.linalg.norm(rotation_wxyz, axis=1, keepdims=True)
    table[:, 13:17] = quats
    header = "ply\nformat binary_little_endian 1.0\n" + f"element vertex {n}\n" + "".join(
        f"property float {name}\n" for name in fields) + "end_header\n"
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(header.encode("ascii") + table.astype("<f4").tobytes())
    return path
