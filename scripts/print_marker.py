"""Write the printable A4 ArUco scale marker (DICT_4X4_50 id 7, 150 mm) to a PDF.

    uv run python scripts/print_marker.py [out.pdf]

Print at 100 % ("actual size"), then check the 10 cm ruler on the sheet.
The server also serves it at GET /api/capture/marker.pdf.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from capture.aruco import marker_pdf_bytes  # noqa: E402


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("sitetwin_marker_A4.pdf")
    out.write_bytes(marker_pdf_bytes())
    print(f"wrote {out} — print at 100 %, the black square must measure 150 mm")


if __name__ == "__main__":
    main()
