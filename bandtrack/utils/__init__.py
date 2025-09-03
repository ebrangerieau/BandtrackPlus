import os
import subprocess
import shlex
import logging
from email.parser import BytesParser
from email.policy import default

def sanitize_name(name: str) -> str | None:
    """Return a sanitized file/display name or ``None`` if invalid."""
    name = (name or '').strip()
    if '..' in name or '/' in name or '\\' in name:
        return None
    return name


logger = logging.getLogger(__name__)


def _log(level: str, message: str) -> None:
    """Log ``message`` using ``level`` or print as a fallback."""
    if logger.hasHandlers():
        getattr(logger, level)(message)
    else:
        print(message)


def scan_for_viruses(file_bytes: bytes) -> bool:
    """Scan ``file_bytes`` using an external command if configured."""
    cmd = os.environ.get('AV_SCAN_CMD')
    if not cmd:
        return True
    try:
        result = subprocess.run(
            shlex.split(cmd),
            input=file_bytes,
            capture_output=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired as exc:
        _log("error", f"Virus scan timed out after {exc.timeout} seconds: {exc}")
        return False
    except Exception as exc:  # pragma: no cover - unexpected errors
        _log("error", f"Virus scan failed: {exc}")
        return False
    if result.returncode != 0:
        stdout = result.stdout.decode(errors="replace") if result.stdout else ""
        stderr = result.stderr.decode(errors="replace") if result.stderr else ""
        _log(
            "warning",
            f"Virus scan returned code {result.returncode}: stdout={stdout!r} stderr={stderr!r}",
        )
        return False
    return True


def parse_multipart_form_data(data: bytes, content_type: str) -> tuple[dict, dict]:
    """Parse ``multipart/form-data`` content from ``data``."""
    parser = BytesParser(policy=default)
    try:
        message = parser.parsebytes(b"Content-Type: " + content_type.encode() + b"\r\n\r\n" + data)
    except Exception:
        return {}, {}

    fields: dict[str, str] = {}
    files: dict[str, dict] = {}
    for part in message.iter_parts():
        if part.get_content_disposition() != "form-data":
            continue
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        filename = part.get_filename()
        payload = part.get_payload(decode=True)
        if filename is not None:
            files[name] = {
                "filename": filename,
                "content_type": part.get_content_type(),
                "content": payload or b"",
            }
        else:
            charset = part.get_content_charset() or "utf-8"
            fields[name] = (payload or b"").decode(charset, errors="replace")
    return fields, files
