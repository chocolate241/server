#!/usr/bin/env python3
import json
import os
import re
import sys
import unicodedata


GARBAGE = {
    "", ".", "..", "...", "…",
    "thank you", "thanks", "bye",
    "you", "thank you for watching",
    "xin chào", "vâng",
}
GARBAGE.update({"xin chao", "vang", "cam on", "hen gap lai", "dung bo lo"})


def normalize_key(text):
    text = unicodedata.normalize("NFD", text or "")
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = text.replace("đ", "d").replace("Đ", "D")
    text = re.sub(r"[^\w\s]", " ", text.lower())
    return " ".join(text.split())


def clean_text(text):
    text = " ".join((text or "").split()).strip()
    key = normalize_key(text)
    if key in GARBAGE:
        return ""
    if any(bad in key for bad in ("cam on", "dung bo lo", "video", "subscribe", "thank you")):
        return ""
    if len(text) > 180 and not any(word in key for word in ("den", "phong", "khach", "ngu", "bep", "bat", "tat")):
        return ""
    if re.search(r"\b(.{6,35}?)\b(?:[,.!? ]+\1\b){3,}", text, flags=re.IGNORECASE):
        return ""
    return text


def main():
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("faster-whisper is not installed. Run: pip install faster-whisper", file=sys.stderr, flush=True)
        sys.exit(1)

    model_size = os.environ.get("WHISPER_MODEL", "small")
    device = os.environ.get("WHISPER_DEVICE", "cpu")
    compute = os.environ.get("WHISPER_COMPUTE", "int8")
    beam_size = int(os.environ.get("WHISPER_BEAM_SIZE", "1"))
    best_of = int(os.environ.get("WHISPER_BEST_OF", "1"))

    print(f"Loading model={model_size} device={device} compute={compute}", file=sys.stderr, flush=True)
    model = WhisperModel(model_size, device=device, compute_type=compute)
    print("Ready", file=sys.stderr, flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
            req_id = str(req.get("id", ""))
            audio_path = req.get("audioPath", "")
            realtime = bool(req.get("realtime", False))

            if not audio_path or not os.path.exists(audio_path):
                raise FileNotFoundError(audio_path)

            segments, _ = model.transcribe(
                audio_path,
                language="vi",
                initial_prompt="Các câu lệnh nhà thông minh bằng tiếng Việt: bật đèn phòng khách, tắt đèn phòng ngủ, bật đèn phòng bếp, bật tất cả đèn, tắt tất cả đèn.",
                beam_size=1 if realtime else beam_size,
                best_of=1 if realtime else best_of,
                vad_filter=True,
                vad_parameters=dict(
                    min_silence_duration_ms=250 if realtime else 300,
                    speech_pad_ms=120 if realtime else 350,
                    threshold=0.3,
                ),
                condition_on_previous_text=False,
                no_speech_threshold=0.6,
                compression_ratio_threshold=2.4,
                log_prob_threshold=-1.0,
                temperature=0.0,
                word_timestamps=False,
            )

            text = clean_text(" ".join(seg.text.strip() for seg in segments if seg.text.strip()))
            print(json.dumps({"id": req_id, "text": text}, ensure_ascii=False), flush=True)
        except Exception as exc:
            req_id = ""
            try:
                req_id = str(json.loads(line).get("id", ""))
            except Exception:
                pass
            print(json.dumps({"id": req_id, "error": str(exc)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
