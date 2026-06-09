# Home Smart ESP32 Wake Word Server

Server nhan audio PCM tu ESP32, STT, parse lenh nha thong minh va gui command ve ESP32.

## Chay local

```bash
npm install
npm run dev
```

Local secret dat trong `config/local.env` hoac bien moi truong cua may. File nay bi `.gitignore`.

## Deploy Render

Render chi can ENV:

```env
NODE_ENV=production
APP_MODE=render
PORT=3000
STT_PROVIDER=deepgram
GEMINI_API_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
DEEPGRAM_API_KEY=
```

Start command:

```bash
npm start
```

Render/free CPU nen dung `STT_PROVIDER=deepgram`. Khong dung `whisper` tren Render neu can phan hoi nhanh, vi model local phai cold start va load CPU/RAM moi lan instance ngu day.

## Them thiet bi

Chi sua `config/devices.json`.

```json
{
  "id": "living",
  "name": "den phong khach",
  "gpio": "D14",
  "alias": ["phong khach", "den khach"]
}
```

Server tu sinh `D14_ON`, `D14_OFF`, local parser, UI va prompt Gemini.

## STT mode

- Local PC: `APP_MODE=local`, `STT_PROVIDER=whisper`
- Render: `APP_MODE=render`, `STT_PROVIDER=deepgram`

Tuning audio nam trong:

- `config/audio.local.json`
- `config/audio.render.json`

## Supabase memory schema

```sql
create table if not exists command_memory (
  key text primary key,
  text text not null,
  commands jsonb not null,
  confidence numeric default 0,
  hit_count integer default 0,
  verified boolean default false,
  last_used timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

Memory chi execute ngay khi `verified = true`. Local parser co confidence cao va duoc luu verified. Gemini fallback duoc luu pending de tranh hoc sai.

## Protocol ESP32 v2

ESP32 gui:

```json
{"type":"hello","device":"esp32-main","version":"1.0","protocol":"2"}
```

Server gui command:

```json
{"type":"command","command":"D14_ON","device":"D14","gpio":14,"state":true}
```

ESP32 ACK:

```json
{"type":"ack","command":"D14_ON","device":"D14","state":true,"success":true}
```

Server van hieu ACK cu `OK D14_ON` trong giai doan chuyen doi.
