"""
Self-hosted call-recording transcription — internal only.

Loads a faster-whisper model once at startup and exposes it over a tiny
HTTP API for OpsFlow's transcriptionSweep.ts to call. Runs auto-detected
language (call recordings mix Hindi/English) rather than forcing one.

Not exposed outside the Docker network — see docker-compose.yml. Never
handles Exotel credentials or fetches recordings itself; OpsFlow downloads
the audio (it already holds those credentials) and posts the bytes here.
"""
import os
import tempfile

from fastapi import FastAPI, File, HTTPException, UploadFile
from faster_whisper import WhisperModel

MODEL_SIZE = os.environ.get("WHISPER_MODEL_SIZE", "base")

app = FastAPI()
model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_SIZE}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Empty file")

    with tempfile.NamedTemporaryFile(suffix=".audio") as tmp:
        tmp.write(contents)
        tmp.flush()
        segments, info = model.transcribe(tmp.name, beam_size=5)
        text = " ".join(segment.text.strip() for segment in segments).strip()

    return {"text": text, "language": info.language}
