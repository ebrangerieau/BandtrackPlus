import os
import subprocess
import shlex
from email.parser import BytesParser
from email.policy import default

def sanitize_name(name: str) -> str | None:
    """Return a sanitized file/display name or ``None`` if invalid."""
    name = (name or '').strip()
    if '..' in name or '/' in name or '\\' in name:
        return None
    return name


def scan_for_viruses(file_bytes: bytes) -> bool:
    """Scan ``file_bytes`` using an external command if configured."""
    cmd = os.environ.get('AV_SCAN_CMD')
    if not cmd:
        return True
    try:
        result = subprocess.run(shlex.split(cmd), input=file_bytes, capture_output=True)
        return result.returncode == 0
    except Exception:
        return False


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
