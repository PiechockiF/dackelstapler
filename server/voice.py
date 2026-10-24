"""Voice endpoints via ElevenLabs: Scribe speech-to-text and streaming text-to-speech.
Both return 501 without ELEVENLABS_API_KEY; the frontend then falls back to the Web Speech API."""

from __future__ import annotations

import os

import httpx
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

router = APIRouter(prefix="/api/voice")
ELEVENLABS = "https://api.elevenlabs.io/v1"
DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb"  # "George", a stock ElevenLabs voice


def api_key() -> str:
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        raise HTTPException(status_code=501, detail="Voice needs ELEVENLABS_API_KEY; using the browser's speech instead.")
    return key


@router.post("/stt")
async def speech_to_text(audio: UploadFile = File(...)) -> dict:
    key = api_key()
    content = await audio.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty audio upload.")
    files = {"file": (audio.filename or "speech.webm", content, audio.content_type or "audio/webm")}
    data = {"model_id": os.environ.get("ELEVENLABS_STT_MODEL", "scribe_v1")}
    language = os.environ.get("ELEVENLABS_STT_LANGUAGE")
    if language:
        data["language_code"] = language
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(f"{ELEVENLABS}/speech-to-text", headers={"xi-api-key": key}, files=files, data=data)
    if response.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Speech-to-text failed ({response.status_code}): {response.text[:200]}")
    return {"text": (response.json().get("text") or "").strip()}


class TtsBody(BaseModel):
    text: str


@router.post("/tts")
async def text_to_speech(body: TtsBody) -> StreamingResponse:
    key = api_key()
    text = body.text.strip()[:2500]
    if not text:
        raise HTTPException(status_code=400, detail="Nothing to say.")
    voice = os.environ.get("ELEVENLABS_VOICE_ID") or DEFAULT_VOICE_ID
    payload = {"text": text, "model_id": os.environ.get("ELEVENLABS_TTS_MODEL", "eleven_flash_v2_5")}
    client = httpx.AsyncClient(timeout=60)
    request = client.build_request(
        "POST", f"{ELEVENLABS}/text-to-speech/{voice}/stream",
        headers={"xi-api-key": key, "accept": "audio/mpeg"}, json=payload,
        params={"output_format": "mp3_44100_128"},
    )
    response = await client.send(request, stream=True)
    if response.status_code >= 400:
        detail = (await response.aread())[:200]
        await response.aclose()
        await client.aclose()
        raise HTTPException(status_code=502, detail=f"Text-to-speech failed ({response.status_code}): {detail!r}")

    async def chunks():
        try:
            async for chunk in response.aiter_bytes():
                yield chunk
        finally:
            await response.aclose()
            await client.aclose()

    return StreamingResponse(chunks(), media_type="audio/mpeg")
