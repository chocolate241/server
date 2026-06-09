#!/usr/bin/env python3
"""
whisper_local.py — Faster-Whisper STT cho Home Smart
Dùng model "small" với language="vi" để nhận dạng tiếng Việt nhanh và chính xác.

Cài đặt:
    pip install faster-whisper

Chạy test:
    python tools/whisper_local.py tmp/session.wav
"""

import sys
import os

def main():
    if len(sys.argv) < 2:
        print("Usage: python whisper_local.py <audio.wav>", file=sys.stderr)
        sys.exit(1)

    audio_path = sys.argv[1]

    if not os.path.exists(audio_path):
        print(f"File not found: {audio_path}", file=sys.stderr)
        sys.exit(1)

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("faster-whisper chưa được cài. Chạy: pip install faster-whisper", file=sys.stderr)
        sys.exit(1)

    # Model size: tiny (fastest) | base | small (recommended) | medium | large
    # device: "cpu" hoặc "cuda" nếu có GPU
    # compute_type: "int8" (nhanh nhất trên CPU), "float16" (GPU)
    model_size = os.environ.get("WHISPER_MODEL", "small")
    device     = os.environ.get("WHISPER_DEVICE", "cpu")
    compute    = os.environ.get("WHISPER_COMPUTE", "int8")

    # Load model (lần đầu sẽ download, sau cache lại)
    model = WhisperModel(
        model_size,
        device=device,
        compute_type=compute,
        # Bỏ download_root nếu muốn cache mặc định
    )

    segments, info = model.transcribe(
        audio_path,
        language="vi",           # Tiếng Việt — bỏ nếu muốn auto-detect
        beam_size=5,
        best_of=5,
        vad_filter=True,         # Lọc im lặng trước khi nhận dạng
        vad_parameters=dict(
            min_silence_duration_ms=300,   # Im lặng >= 300ms thì cắt
            speech_pad_ms=200,             # Thêm 200ms trước/sau giọng nói
            threshold=0.3,                 # Ngưỡng VAD (0.1-0.9, nhỏ = nhạy hơn)
        ),
        condition_on_previous_text=False,  # Không cần context trước
        no_speech_threshold=0.6,           # Nếu model nghĩ không có lời nói → bỏ qua
        compression_ratio_threshold=2.4,   # Lọc kết quả lặp lại bất thường
        log_prob_threshold=-1.0,
        temperature=0.0,                   # Greedy decoding (nhanh hơn sampling)
        word_timestamps=False,             # Không cần timestamp từng từ
    )

    # Ghép tất cả segment thành 1 chuỗi
    texts = []
    for seg in segments:
        t = seg.text.strip()
        if t:
            texts.append(t)

    result = " ".join(texts).strip()

    # Loại bỏ các output rác phổ biến của Whisper khi không có tiếng
    GARBAGE = {
        "", ".", "..", "...", "…",
        "thank you", "thanks", "bye",
        "you", "thank you for watching",
        "xin chào", "vâng",  # hallucination thường gặp
    }

    if result.lower() in GARBAGE:
        result = ""

    print(result)

if __name__ == "__main__":
    main()
