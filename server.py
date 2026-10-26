from __future__ import annotations

import json
import os
import re
import time
from email import policy
from email.parser import BytesParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from urllib.parse import urlparse

from sarvamai import SarvamAI
from sarvamai.core.api_error import ApiError


APP_DIR = Path(__file__).resolve().parent
# Leave headroom under Vercel Functions' 4.5 MB request payload limit.
MAX_REQUEST_BYTES = 4 * 1024 * 1024
TERMINAL_STATES = {"completed", "partially_completed", "failed", "rejected"}
POSTER_SCHEMA = {
    "type": "object",
    "properties": {
        "event_title": {"type": "string", "description": "Name or title of the event"},
        "date": {"type": "string", "description": "Event date exactly as printed"},
        "time": {"type": "string", "description": "Event start time exactly as printed"},
        "venue": {"type": "string", "description": "Event location or venue exactly as printed"},
        "instructions": {"type": "string", "description": "Registration, items to bring, or other attendee instructions"},
    },
}


def load_local_key() -> None:
    """Read a developer's local key without logging or committing it."""
    if os.environ.get("SARVAM_API_KEY"):
        return
    local_env = APP_DIR.parent / "sarvam-first-call" / ".env"
    if not local_env.is_file():
        return
    for line in local_env.read_text(encoding="utf-8").splitlines():
        name, separator, value = line.partition("=")
        if separator and name.strip() == "SARVAM_API_KEY":
            os.environ["SARVAM_API_KEY"] = value.strip().strip("\"'")
            return


def api_client() -> SarvamAI:
    load_local_key()
    key = os.environ.get("SARVAM_API_KEY")
    if not key:
        raise ValueError("Add SARVAM_API_KEY to your environment before analysing an event.")
    return SarvamAI(api_subscription_key=key, timeout=90.0)


def to_plain(value):
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if isinstance(value, dict):
        return {str(k): to_plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_plain(item) for item in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def upload_parts(content_type: str, body: bytes) -> dict[str, tuple[str, bytes, str]]:
    message_bytes = (
        f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8") + body
    )
    message = BytesParser(policy=policy.default).parsebytes(message_bytes)
    fields = {}
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        filename = part.get_filename() or ""
        payload = part.get_payload(decode=True) or b""
        mime = part.get_content_type()
        fields[name] = (filename, payload, mime)
    return fields


def extract_poster(client: SarvamAI, filename: str, data: bytes, mime: str) -> dict:
    with BytesIO(data) as file_obj:
        file_obj.name = filename
        job = client.doc_ai.extract(
            file=[(filename, file_obj, mime)],
            schema=json.dumps(POSTER_SCHEMA),
            output_format="json",
        )
    deadline = time.monotonic() + 75
    while time.monotonic() < deadline:
        status = client.doc_ai.get_status(job_id=job.job_id)
        state = str(status.status).lower()
        if state in TERMINAL_STATES:
            if state not in {"completed", "partially_completed"}:
                raise RuntimeError("Sarvam Vision could not read this poster. Try a clearer image or PDF.")
            result = client.doc_ai.get_results(job_id=job.job_id)
            plain = to_plain(result)
            extracted = plain.get("result", plain) if isinstance(plain, dict) else plain
            annotations = plain.get("annotations") if isinstance(plain, dict) else None
            return {"fields": extracted, "annotations": annotations}
        time.sleep(5)
    raise TimeoutError("Poster extraction is taking longer than expected. Please try again.")


def transcribe_audio(client: SarvamAI, filename: str, data: bytes, mime: str) -> str:
    audio = BytesIO(data)
    audio.name = filename
    result = client.speech_to_text.transcribe(file=audio, model="saaras:v4", mode="transcribe")
    return str(result.transcript).strip()


def review_sources(client: SarvamAI, poster_fields, transcript: str) -> dict:
    prompt = {
        "poster_fields": poster_fields,
        "spoken_announcement_transcript": transcript,
        "task": (
            "Compare these two sources for one campus event. Return ONLY a JSON object with keys: "
            "event_title, summary, needs_confirmation, fields, calendar. fields must contain objects with "
            "label, poster_value, announcement_value, status, and note. Compare date, time, venue, "
            "and instructions when present. status must be one of match, conflict, poster_only, "
            "announcement_only, or unclear. Do not guess missing facts or decide which source is right. "
            "Quote short evidence in note. Write the summary in English. If sources disagree, set "
            "needs_confirmation=true and explain that a person should confirm it. calendar must be an "
            "object with date (YYYY-MM-DD), start_time and end_time (24-hour HH:MM), and venue. "
            "Only fill a calendar value when it is explicit in the source and unambiguous; use null "
            "otherwise. Never fill a conflicting time or date."
        ),
    }
    response = client.chat.completions(
        model="sarvam-105b-conversations",
        messages=[
            {"role": "system", "content": "You compare event notices carefully. Never invent dates, times, or locations."},
            {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)},
        ],
        temperature=0,
        reasoning_effort=None,
        max_tokens=700,
    )
    raw = str(response.choices[0].message.content or "").strip()
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.IGNORECASE)
    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass
    return {
        "event_title": "Event details",
        "summary": "Review the source details below before sharing this event.",
        "needs_confirmation": True,
        "fields": [],
        "raw_review": raw,
    }


def card_text(review: dict) -> str:
    title = str(review.get("event_title") or "Campus event")
    fields = review.get("fields") or []
    lines = [title]
    for item in fields:
        label = str(item.get("label") or "Detail")
        poster_value = str(item.get("poster_value") or "").strip()
        audio_value = str(item.get("announcement_value") or "").strip()
        status = str(item.get("status") or "unclear")
        if status == "match" and poster_value:
            lines.append(f"{label}: {poster_value}")
        elif poster_value or audio_value:
            lines.append(f"{label}: Please confirm. Poster says {poster_value or 'not shown'}; announcement says {audio_value or 'not mentioned'}.")
    summary = str(review.get("summary") or "").strip()
    if summary:
        lines.append(summary)
    if review.get("needs_confirmation"):
        lines.append("Some details need confirmation before you go.")
    return "\n".join(lines)[:1900]


class NoticeSahiHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR / "public"), **kwargs)

    def log_message(self, format, *args):
        # Keep uploaded filenames and request data out of server logs.
        return

    def send_json(self, status: int, payload: dict):
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        if urlparse(self.path).path == "/api/health":
            load_local_key()
            self.send_json(200, {"ok": True, "key_configured": bool(os.environ.get("SARVAM_API_KEY"))})
            return
        if urlparse(self.path).path.startswith("/api/"):
            self.send_json(404, {"error": "That API route was not found."})
            return
        return super().do_GET()

    def do_POST(self):
        route = urlparse(self.path).path
        try:
            if route == "/api/analyze":
                self.handle_analyze()
            elif route == "/api/translate":
                self.handle_translate()
            elif route == "/api/speak":
                self.handle_speak()
            else:
                self.send_json(404, {"error": "That API route was not found."})
        except ValueError as exc:
            self.send_json(400, {"error": str(exc)})
        except TimeoutError as exc:
            self.send_json(504, {"error": str(exc)})
        except ApiError as exc:
            messages = {
                402: "This Sarvam account needs credits for that API step.",
                403: "Sarvam could not authorize this request. Check the key and API access.",
                413: "That file is too large for this demo. Use a smaller file.",
                422: "Sarvam could not read that file format. Try a clear JPG, PNG, PDF, or supported audio file.",
                429: "Sarvam is receiving too many requests. Wait a moment and try again.",
            }
            self.send_json(exc.status_code if 400 <= exc.status_code < 600 else 502,
                           {"error": messages.get(exc.status_code, "Sarvam could not complete this step. Please try again.")})
        except Exception:
            self.send_json(502, {"error": "Something went wrong while analysing the event. Please try again."})

    def read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 32_000:
            raise ValueError("The request is empty or too large.")
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("Please send valid event details.")

    def handle_analyze(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_REQUEST_BYTES:
            raise ValueError("Keep the poster and audio together under 4 MB for this deployment.")
        content_type = self.headers.get("Content-Type", "")
        if not content_type.startswith("multipart/form-data"):
            raise ValueError("Choose a poster and an audio announcement first.")
        parts = upload_parts(content_type, self.rfile.read(length))
        poster_name, poster_data, poster_mime = parts.get("poster", ("", b"", ""))
        audio_name, audio_data, audio_mime = parts.get("audio", ("", b"", ""))
        if not poster_name or not poster_data or not audio_name or not audio_data:
            raise ValueError("Add both an event poster and a spoken announcement.")
        if poster_mime not in {"image/jpeg", "image/png", "application/pdf"}:
            raise ValueError("Use a JPG, PNG, or PDF poster.")
        if len(audio_data) > 3 * 1024 * 1024:
            raise ValueError("Keep the audio clip under 3 MB and the combined upload under 4 MB.")

        client = api_client()
        poster = extract_poster(client, poster_name, poster_data, poster_mime)
        transcript = transcribe_audio(client, audio_name, audio_data, audio_mime)
        review = review_sources(client, poster["fields"], transcript)
        target = parts.get("language", ("", b"en-IN", ""))[1].decode("utf-8", "ignore") or "en-IN"
        translated = None
        if target != "en-IN":
            translated = client.text.translate(
                input=card_text(review),
                source_language_code="en-IN",
                target_language_code=target,
                model="sarvam-translate:v1",
            ).translated_text
        self.send_json(200, {
            "poster_fields": poster["fields"],
            "annotations": poster["annotations"],
            "transcript": transcript,
            "review": review,
            "card_text": card_text(review),
            "translated_text": translated,
            "language": target,
        })

    def handle_translate(self):
        data = self.read_json_body()
        text = str(data.get("text") or "").strip()
        target = str(data.get("language") or "").strip()
        if not text or len(text) > 1900:
            raise ValueError("The event card needs text under 1,900 characters.")
        if not target:
            raise ValueError("Choose a language for the card.")
        result = api_client().text.translate(
            input=text,
            source_language_code="en-IN",
            target_language_code=target,
            model="sarvam-translate:v1",
        )
        self.send_json(200, {"translated_text": result.translated_text})

    def handle_speak(self):
        data = self.read_json_body()
        text = str(data.get("text") or "").strip()
        language = str(data.get("language") or "en-IN").strip()
        if not text or len(text) > 2400:
            raise ValueError("The spoken card needs text under 2,400 characters.")
        result = api_client().text_to_speech.convert(
            text=text,
            language_code=language,
            model="bulbul:v4-flash",
        )
        audio_item = result.audios[0]
        audio_b64 = getattr(audio_item, "audio", audio_item)
        self.send_json(200, {"audio_base64": audio_b64, "mime_type": "audio/wav"})


def main():
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), NoticeSahiHandler)
    print(f"NoticeSahi is ready at http://localhost:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
