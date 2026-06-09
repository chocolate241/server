/* Edge Impulse Arduino examples
 * Copyright (c) 2022 EdgeImpulse Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// These sketches are tested with 2.0.4 ESP32 Arduino Core
// https://github.com/espressif/arduino-esp32/releases/tag/2.0.4

// If your target is limited in memory remove this macro to save 10K RAM
#define EIDSP_QUANTIZE_FILTERBANK   0

/*
 ** NOTE: If you run into TFLite arena allocation issue.
 **
 ** This may be due to may dynamic memory fragmentation.
 ** Try defining "-DEI_CLASSIFIER_ALLOCATION_STATIC" in boards.local.txt (create
 ** if it doesn't exist) and copy this file to
 ** `<ARDUINO_CORE_INSTALL_PATH>/arduino/hardware/<mbed_core>/<core_version>/`.
 **
 ** See
 ** (https://support.arduino.cc/hc/en-us/articles/360012076960-Where-are-the-installed-cores-located-)
 ** to find where Arduino installs cores on your machine.
 **
 ** If the problem persists then there's not enough memory for this model and application.
 */

/* Includes ---------------------------------------------------------------- */
#include <Hey_Reachy_-_Wake_word_detection_inferencing.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "driver/i2s.h"
#include <WiFi.h>
#include <Preferences.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <WebSocketsClient.h>
#include <string.h>

static const char *WAKE_LABEL = "hey_reachy";
static const float WAKE_THRESHOLD = 0.80f;
static const uint32_t WAKE_COOLDOWN_MS = 400;
static const uint8_t WAKE_HITS_REQUIRED = 1;
static const bool DEBUG_BOOT_MODEL_INFO = false;
static const bool DEBUG_WAKE_SCORE_LOG = true;
static const uint32_t WAKE_SCORE_LOG_MS = 700;
static const float WAKE_SCORE_LOG_MIN = 0.05f;
static const uint32_t WARN_VISIBLE_MS = 2000;

#define LED_WARN      33   // Nhay khi mat WiFi / WS
#define LED_MIC       25   // Sang khi dang ghi lenh

#define I2S_WS        12   // INMP441 LRCL/WS
#define I2S_SD        15   // INMP441 DOUT
#define I2S_SCK       13   // INMP441 BCLK
#define I2S_PORT      I2S_NUM_0

static const char *DEFAULT_WS_HOST = "192.168.100.192";
static const uint16_t DEFAULT_WS_PORT = 3000;
static const char *DEFAULT_WS_PATH = "/";
static const char *DEFAULT_DEVICE_ID = "esp32-main";
static const char *DEFAULT_ROOM = "main";
static const char *PROTOCOL_VERSION = "2";

static const char *AP_SSID = "ESP32_SETUP";
static const char *AP_PASS = "12345678";
static const byte DNS_PORT = 53;
static const uint32_t WIFI_TIMEOUT_MS = 15000;
static const uint32_t WIFI_RETRY_MS = 10000;
static const uint32_t RESTART_DELAY_MS = 2000;

static const i2s_channel_fmt_t I2S_MIC_CHANNEL = I2S_CHANNEL_FMT_ONLY_LEFT;
static const int I2S_SAMPLE_SHIFT = 14;
static const int AUDIO_GAIN = 4;
static const int VOICE_AUDIO_GAIN = 2;
static const bool VOICE_HIGH_PASS_ENABLED = true;
static const float VOICE_HIGH_PASS_ALPHA = 0.955f; // about 120 Hz at 16 kHz

/** Audio buffers, pointers and selectors */
typedef struct {
    signed short *buffers[2];
    unsigned char buf_select;
    unsigned char buf_ready;
    unsigned int buf_count;
    unsigned int n_samples;
} inference_t;

static inference_t inference;
static const uint32_t sample_buffer_size = 512;
static int32_t i2sRawBuffer[sample_buffer_size];
static signed short sampleBuffer[sample_buffer_size];
static signed short voiceSendBuffer[sample_buffer_size];
static bool debug_nn = false; // Set this to true to see e.g. features generated from the raw signal
static bool record_status = true;
static volatile bool ws_connected = false;
static bool wifi_connected_logged = false;
static bool ws_connected_logged = false;
static volatile bool voice_capture_active = false;
static volatile bool wake_paused_by_server = false;
static bool wake_ready_notice_pending = false;
static uint8_t wake_hits = 0;
static uint32_t last_wake_ms = 0;
static uint32_t last_wake_score_log_ms = 0;
static uint32_t led_mic_until_ms = 0;
static uint32_t led_warn_pulse_until_ms = 0;
static uint32_t last_wifi_check_ms = 0;
static float voice_hp_prev_in = 0.0f;
static float voice_hp_prev_out = 0.0f;
static bool portal_active = false;
static bool restart_pending = false;
static uint32_t restart_at_ms = 0;
static String saved_ssid;
static String saved_pass;
static String saved_ws_host;
static uint16_t saved_ws_port = DEFAULT_WS_PORT;
static String saved_ws_path;
static String saved_device_id;
static String saved_room;
static String wifi_list_html;
static Preferences prefs;
static WebServer httpServer(80);
static DNSServer dns;
static WebSocketsClient webSocket;

static String html_esc(const String& s);
static void restart_soon(void);
static void scan_wifi_networks(void);
static void handle_portal_root(void);
static void handle_portal_save(void);
static void handle_portal_reset(void);
static void redirect_portal_root(void);
static void start_portal(void);
static bool load_saved_wifi(void);
static void connect_wifi(void);
static void connect_websocket(void);
static void service_network(void);
static void web_socket_event(WStype_t type, uint8_t *payload, size_t length);
static void send_ws_text(const char *text);
static void send_ws_hello(void);
static bool json_get_string(const char *json, const char *key, char *out, size_t out_len);
static bool json_get_int(const char *json, const char *key, int *out);
static bool json_get_bool(const char *json, const char *key, bool *out);
static int gpio_from_device(const char *device);
static void send_command_ack(const char *command, const char *device, bool state, bool success);
static void reset_inference_buffer(void);
static void reset_voice_filter(void);
static int16_t process_voice_stream_sample(int32_t raw_sample);
static void start_voice_capture(void);
static void handle_server_text(const char *text);
static void apply_light_command(const char *cmd);
static void apply_json_command(const char *json);
static void handle_wake_word_result(ei_impulse_result_t *result);
static void update_status_leds(void);

/**
 * @brief      Arduino setup function
 */
void setup()
{
    // put your setup code here, to run once:
    Serial.begin(115200);
    pinMode(LED_WARN, OUTPUT);
    pinMode(LED_MIC, OUTPUT);
    digitalWrite(LED_WARN, LOW);
    digitalWrite(LED_MIC, LOW);

    delay(500);
    Serial.println("ESP32: khoi dong wake word");

    // summary of inferencing settings (from model_metadata.h)
    if (DEBUG_BOOT_MODEL_INFO) {
        ei_printf("Inferencing settings:\n");
        ei_printf("\tInterval: ");
        ei_printf_float((float)EI_CLASSIFIER_INTERVAL_MS);
        ei_printf(" ms.\n");
        ei_printf("\tFrame size: %d\n", EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE);
        ei_printf("\tSample length: %d ms.\n", EI_CLASSIFIER_RAW_SAMPLE_COUNT / (EI_CLASSIFIER_FREQUENCY / 1000));
        ei_printf("\tSlice size: %d samples.\n", EI_CLASSIFIER_SLICE_SIZE);
        ei_printf("\tNo. of classes: %d\n", sizeof(ei_classifier_inferencing_categories) / sizeof(ei_classifier_inferencing_categories[0]));
        ei_printf("\tWake threshold: ");
        ei_printf_float(WAKE_THRESHOLD);
        ei_printf("\n");
    }

    run_classifier_init();
    Serial.println("WAKE: dang cho wake word");
    ei_sleep(2000);

    if (microphone_inference_start(EI_CLASSIFIER_SLICE_SIZE) == false) {
        ei_printf("ERR: Could not allocate audio buffer (size %d), this could be due to the window length of your model\r\n", EI_CLASSIFIER_RAW_SAMPLE_COUNT);
        return;
    }

    Serial.println("MIC: san sang");

    connect_wifi();
    if (!portal_active) {
        connect_websocket();
    }
}

/**
 * @brief      Arduino main function. Runs the inferencing loop.
 */
void loop()
{
    service_network();
    update_status_leds();

    if (voice_capture_active || wake_paused_by_server) {
        delay(5);
        return;
    }

    bool m = microphone_inference_record();
    if (!m) {
        ei_printf("ERR: Failed to record audio...\n");
        return;
    }

    signal_t signal;
    signal.total_length = EI_CLASSIFIER_SLICE_SIZE;
    signal.get_data = &microphone_audio_signal_get_data;
    ei_impulse_result_t result = {0};

    EI_IMPULSE_ERROR r = run_classifier_continuous(&signal, &result, debug_nn);
    if (r != EI_IMPULSE_OK) {
        ei_printf("ERR: Failed to run classifier (%d)\n", r);
        return;
    }

    if (wake_ready_notice_pending) {
        wake_ready_notice_pending = false;
        send_ws_text("{\"type\":\"wake_ready\"}");
        Serial.println("WAKE: san sang nghe tiep");
    }

    handle_wake_word_result(&result);
    update_status_leds();
    service_network();
}

static String html_esc(const String& s)
{
    String r = s;
    r.replace("&", "&amp;");
    r.replace("\"", "&quot;");
    r.replace("<", "&lt;");
    r.replace(">", "&gt;");
    return r;
}

static void restart_soon(void)
{
    restart_pending = true;
    restart_at_ms = millis() + RESTART_DELAY_MS;
}

static void scan_wifi_networks(void)
{
    wifi_list_html = "";
    wifi_list_html.reserve(2500);
    WiFi.scanDelete();
    delay(200);

    int n = WiFi.scanNetworks(false, true);
    if (n <= 0) {
        delay(500);
        n = WiFi.scanNetworks(false, true);
    }

    if (n <= 0) {
        wifi_list_html = "<div class='item'>Khong tim thay WiFi.</div>";
        return;
    }

    for (int i = 0; i < n; i++) {
        String ssid = WiFi.SSID(i);
        if (!ssid.length()) {
            continue;
        }
        String safe = html_esc(ssid);
        wifi_list_html += "<div class='item' onclick='pick(\"" + safe + "\")'>" +
                          safe + " <small>(" + String(WiFi.RSSI(i)) + "dBm)</small></div>";
    }

    WiFi.scanDelete();
    if (!wifi_list_html.length()) {
        wifi_list_html = "<div class='item'>Khong tim thay WiFi co ten.</div>";
    }
}

static void handle_portal_root(void)
{
    String html = F(
        "<!DOCTYPE html><html lang='vi'><head><meta charset='UTF-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        "<style>body{margin:0;font-family:Arial;background:#20242b;color:#eee;"
        "display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px}"
        ".box{width:100%;max-width:380px;background:#111;padding:22px;border-radius:20px}"
        "h2{text-align:center;color:#8ea8ff;margin:0 0 16px}label{font-size:14px;font-weight:bold}"
        ".list{max-height:180px;overflow:auto;background:#1f1f1f;border:1px solid #444;"
        "border-radius:12px;padding:6px;margin-bottom:12px}"
        ".item{padding:10px;border-radius:10px;margin-bottom:5px;background:#111;"
        "border:1px solid #444;cursor:pointer;font-size:14px}.item:hover{background:#263344}"
        "input{width:100%;padding:12px;margin:6px 0 12px;border:1px solid #666;"
        "border-radius:12px;box-sizing:border-box;font-size:15px;background:#3a3a3a;color:white}"
        "button{width:100%;padding:13px;border:0;border-radius:12px;background:#377bd8;"
        "color:white;font-weight:bold;font-size:16px;cursor:pointer}"
        "a.reset{display:block;text-align:center;margin-top:14px;color:#ff7777;font-size:14px}"
        "</style><script>function pick(s){document.getElementById('ssid').value=s}</script>"
        "</head><body><div class='box'><h2>Cai dat WiFi</h2>"
        "<a href='/rescan' style='display:block;text-align:center;color:#6aa9ff;"
        "font-size:13px;margin-bottom:10px'>Quet lai WiFi</a>"
        "<div class='list'>WIFI_LIST</div>"
        "<form action='/save' method='POST'>"
        "<label>Ten WiFi</label>"
        "<input id='ssid' name='ssid' placeholder='Chon hoac tu nhap' required>"
        "<label>Mat khau</label>"
        "<input type='password' name='pass' placeholder='Nhap mat khau'>"
        "<label>Server host</label>"
        "<input name='host' value='SERVER_HOST' placeholder='reachy.local hoac render host' required>"
        "<label>Server port</label>"
        "<input name='port' value='SERVER_PORT' placeholder='3000 hoac 443' required>"
        "<label>Server path</label>"
        "<input name='path' value='SERVER_PATH' placeholder='/'>"
        "<label>Device ID</label>"
        "<input name='device' value='DEVICE_ID' placeholder='esp32-main'>"
        "<label>Room</label>"
        "<input name='room' value='ROOM_ID' placeholder='main'>"
        "<button type='submit'>Luu va ket noi</button></form>"
        "<a class='reset' href='/reset'>Xoa WiFi da luu</a>"
        "</div></body></html>"
    );
    html.replace("WIFI_LIST", wifi_list_html);
    html.replace("SERVER_HOST", html_esc(saved_ws_host.length() ? saved_ws_host : DEFAULT_WS_HOST));
    html.replace("SERVER_PORT", String(saved_ws_port ? saved_ws_port : DEFAULT_WS_PORT));
    html.replace("SERVER_PATH", html_esc(saved_ws_path.length() ? saved_ws_path : DEFAULT_WS_PATH));
    html.replace("DEVICE_ID", html_esc(saved_device_id.length() ? saved_device_id : DEFAULT_DEVICE_ID));
    html.replace("ROOM_ID", html_esc(saved_room.length() ? saved_room : DEFAULT_ROOM));
    httpServer.send(200, "text/html", html);
}

static void send_portal_msg(const char* text, bool ok)
{
    String html = "<!DOCTYPE html><html lang='vi'><head><meta charset='UTF-8'>"
                  "<style>body{font-family:Arial;background:#20242b;display:flex;align-items:center;"
                  "justify-content:center;min-height:100vh;color:white}"
                  ".box{background:#111;padding:24px;border-radius:16px;text-align:center;max-width:340px}"
                  "</style></head><body><div class='box'><h3 style='color:";
    html += ok ? "#4ade80" : "#ff7777";
    html += "'>";
    html += text;
    html += "</h3><p>ESP32 se khoi dong lai...</p></div></body></html>";
    httpServer.send(200, "text/html", html);
    httpServer.client().flush();
}

static void handle_portal_save(void)
{
    String ssid = httpServer.arg("ssid");
    String pass = httpServer.arg("pass");
    String host = httpServer.arg("host");
    String port = httpServer.arg("port");
    String ws_path = httpServer.arg("path");
    String device = httpServer.arg("device");
    String room = httpServer.arg("room");
    ssid.trim();
    host.trim();
    port.trim();
    ws_path.trim();
    device.trim();
    room.trim();
    if (!ssid.length()) {
        send_portal_msg("SSID khong hop le", false);
        return;
    }
    if (!host.length()) host = DEFAULT_WS_HOST;
    if (!port.length()) port = String(DEFAULT_WS_PORT);
    if (!ws_path.length()) ws_path = DEFAULT_WS_PATH;
    if (ws_path[0] != '/') ws_path = "/" + ws_path;
    if (!device.length()) device = DEFAULT_DEVICE_ID;
    if (!room.length()) room = DEFAULT_ROOM;

    prefs.begin("wifi", false);
    prefs.putString("ssid", ssid);
    prefs.putString("pass", pass);
    prefs.putString("host", host);
    prefs.putUShort("port", (uint16_t)port.toInt());
    prefs.putString("path", ws_path);
    prefs.putString("device", device);
    prefs.putString("room", room);
    prefs.putString("protocol", PROTOCOL_VERSION);
    prefs.end();

    Serial.println("WIFI: da luu cau hinh: " + ssid + ", server=" + host + ":" + port);
    send_portal_msg("Da luu cau hinh thanh cong!", true);
    restart_soon();
}

static void handle_portal_reset(void)
{
    prefs.begin("wifi", false);
    prefs.clear();
    prefs.end();
    WiFi.disconnect(true, true);
    send_portal_msg("Da xoa WiFi", false);
    restart_soon();
}

static void redirect_portal_root(void)
{
    httpServer.sendHeader("Location", "/", true);
    httpServer.send(302, "text/plain", "");
}

static void start_portal(void)
{
    portal_active = true;
    ws_connected = false;
    voice_capture_active = false;
    wake_paused_by_server = false;

    WiFi.disconnect(true, true);
    delay(300);
    WiFi.mode(WIFI_AP_STA);
    delay(200);

    if (!WiFi.softAP(AP_SSID, AP_PASS)) {
        Serial.println("WIFI: khong mo duoc cong cai dat");
        return;
    }

    scan_wifi_networks();
    IPAddress ip = WiFi.softAPIP();
    dns.start(DNS_PORT, "*", ip);

    httpServer.on("/", HTTP_GET, handle_portal_root);
    httpServer.on("/rescan", HTTP_GET, []() { scan_wifi_networks(); handle_portal_root(); });
    httpServer.on("/save", HTTP_POST, handle_portal_save);
    httpServer.on("/reset", HTTP_GET, handle_portal_reset);
    httpServer.on("/generate_204", HTTP_GET, handle_portal_root);
    httpServer.on("/fwlink", HTTP_GET, handle_portal_root);
    httpServer.onNotFound(redirect_portal_root);
    httpServer.begin();

    digitalWrite(LED_WARN, HIGH);
    Serial.printf("WIFI: ket noi dien thoai vao %s, mat khau %s, mo http://%s\n",
        AP_SSID, AP_PASS, ip.toString().c_str());
}

static bool load_saved_wifi(void)
{
    prefs.begin("wifi", true);
    saved_ssid = prefs.getString("ssid", "");
    saved_pass = prefs.getString("pass", "");
    saved_ws_host = prefs.getString("host", DEFAULT_WS_HOST);
    saved_ws_port = prefs.getUShort("port", DEFAULT_WS_PORT);
    saved_ws_path = prefs.getString("path", DEFAULT_WS_PATH);
    saved_device_id = prefs.getString("device", DEFAULT_DEVICE_ID);
    saved_room = prefs.getString("room", DEFAULT_ROOM);
    prefs.end();
    saved_ssid.trim();
    saved_ws_host.trim();
    saved_ws_path.trim();
    saved_device_id.trim();
    saved_room.trim();
    if (!saved_ws_host.length()) saved_ws_host = DEFAULT_WS_HOST;
    if (!saved_ws_port) saved_ws_port = DEFAULT_WS_PORT;
    if (!saved_ws_path.length()) saved_ws_path = DEFAULT_WS_PATH;
    if (saved_ws_path[0] != '/') saved_ws_path = "/" + saved_ws_path;
    if (!saved_device_id.length()) saved_device_id = DEFAULT_DEVICE_ID;
    if (!saved_room.length()) saved_room = DEFAULT_ROOM;
    return saved_ssid.length() > 0;
}

static void connect_wifi(void)
{
    if (!load_saved_wifi()) {
        Serial.println("WIFI: chua co WiFi da luu, mo cong cai dat");
        start_portal();
        return;
    }

    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);
    WiFi.setAutoReconnect(true);
    WiFi.begin(saved_ssid.c_str(), saved_pass.c_str());
    Serial.println("WIFI: dang ket noi: " + saved_ssid);

    uint32_t start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_TIMEOUT_MS) {
        digitalWrite(LED_WARN, !digitalRead(LED_WARN));
        delay(250);
    }

    if (WiFi.status() == WL_CONNECTED) {
        digitalWrite(LED_WARN, LOW);
        wifi_connected_logged = true;
        Serial.println("WIFI: da ket noi, IP: " + WiFi.localIP().toString());
    }
    else {
        Serial.println("WIFI: ket noi that bai, mo cong cai dat");
        start_portal();
    }
}

static void connect_websocket(void)
{
    if (!saved_ws_host.length()) {
        load_saved_wifi();
    }

    if (saved_ws_port == 443) {
        webSocket.beginSSL(saved_ws_host.c_str(), saved_ws_port, saved_ws_path.c_str());
    }
    else {
        webSocket.begin(saved_ws_host.c_str(), saved_ws_port, saved_ws_path.c_str());
    }
    webSocket.onEvent(web_socket_event);
    webSocket.setReconnectInterval(3000);
    webSocket.enableHeartbeat(15000, 3000, 2);
    Serial.printf("WS: ket noi toi %s:%u%s\n", saved_ws_host.c_str(), saved_ws_port, saved_ws_path.c_str());
}

static void service_network(void)
{
    uint32_t now = millis();

    if (restart_pending && now >= restart_at_ms) {
        Serial.println("HE THONG: khoi dong lai");
        ESP.restart();
    }

    if (portal_active) {
        dns.processNextRequest();
        httpServer.handleClient();
        if (led_warn_pulse_until_ms == 0) {
            digitalWrite(LED_WARN, (now / 500) % 2);
        }
        return;
    }

    if (WiFi.status() != WL_CONNECTED) {
        wifi_connected_logged = false;
        if (led_warn_pulse_until_ms == 0) {
            digitalWrite(LED_WARN, (now / 250) % 2);
        }
        if (now - last_wifi_check_ms >= WIFI_RETRY_MS) {
            last_wifi_check_ms = now;
            WiFi.disconnect();
            if (saved_ssid.length()) {
                WiFi.begin(saved_ssid.c_str(), saved_pass.c_str());
            }
        }
    }
    else if (!ws_connected) {
        if (!wifi_connected_logged) {
            wifi_connected_logged = true;
            Serial.printf("WIFI: da ket noi, IP: %s\n", WiFi.localIP().toString().c_str());
        }
        if (led_warn_pulse_until_ms == 0) {
            digitalWrite(LED_WARN, (now / 500) % 2);
        }
    }
    else {
        if (!wifi_connected_logged) {
            wifi_connected_logged = true;
            Serial.printf("WIFI: da ket noi, IP: %s\n", WiFi.localIP().toString().c_str());
        }
        if (led_warn_pulse_until_ms == 0) {
            digitalWrite(LED_WARN, LOW);
        }
    }

    if (WiFi.status() == WL_CONNECTED) {
        webSocket.loop();
    }

}

static void web_socket_event(WStype_t type, uint8_t *payload, size_t length)
{
    switch (type) {
        case WStype_CONNECTED:
            ws_connected = true;
            if (led_warn_pulse_until_ms == 0) {
                digitalWrite(LED_WARN, LOW);
            }
            if (!ws_connected_logged) {
                ws_connected_logged = true;
                Serial.println("WS: da ket noi server");
            }
            send_ws_hello();
            break;

        case WStype_DISCONNECTED:
            if (ws_connected_logged) {
                Serial.println("WS: mat ket noi server");
            }
            ws_connected = false;
            ws_connected_logged = false;
            voice_capture_active = false;
            wake_paused_by_server = false;
            led_mic_until_ms = 0;
            digitalWrite(LED_MIC, LOW);
            break;

        case WStype_TEXT:
            if (payload && length > 0) {
                char text[96];
                size_t copy_len = length < sizeof(text) - 1 ? length : sizeof(text) - 1;
                memcpy(text, payload, copy_len);
                text[copy_len] = '\0';
                handle_server_text(text);
            }
            break;

        default:
            break;
    }
}

static void send_ws_text(const char *text)
{
    if (ws_connected) {
        webSocket.sendTXT(text);
    }
}

static void send_ws_hello(void)
{
    String msg = "{\"type\":\"hello\",\"device\":\"";
    msg += saved_device_id.length() ? saved_device_id : DEFAULT_DEVICE_ID;
    msg += "\",\"version\":\"1.0\",\"protocol\":\"";
    msg += PROTOCOL_VERSION;
    msg += "\",\"room\":\"";
    msg += saved_room.length() ? saved_room : DEFAULT_ROOM;
    msg += "\"}";
    send_ws_text(msg.c_str());
}

static void reset_inference_buffer(void)
{
    inference.buf_ready = 0;
    inference.buf_count = 0;
    inference.buf_select = 0;
}

static void reset_voice_filter(void)
{
    voice_hp_prev_in = 0.0f;
    voice_hp_prev_out = 0.0f;
}

static int16_t process_voice_stream_sample(int32_t raw_sample)
{
    float x = (float)(raw_sample * VOICE_AUDIO_GAIN);
    float y = x;

    if (VOICE_HIGH_PASS_ENABLED) {
        y = VOICE_HIGH_PASS_ALPHA * (voice_hp_prev_out + x - voice_hp_prev_in);
        voice_hp_prev_in = x;
        voice_hp_prev_out = y;
    }

    if (y > 32767.0f) {
        y = 32767.0f;
    }
    else if (y < -32768.0f) {
        y = -32768.0f;
    }

    return (int16_t)y;
}

static void start_voice_capture(void)
{
    if (!ws_connected || wake_paused_by_server) {
        return;
    }

    if (voice_capture_active) {
        return;
    }

    reset_inference_buffer();
    reset_voice_filter();
    voice_capture_active = true;
    led_mic_until_ms = 0;
    digitalWrite(LED_MIC, HIGH);
    send_ws_text("{\"type\":\"wake_detected\"}");
    Serial.println("MIC: bat dau thu lenh");
}

static bool json_get_string(const char *json, const char *key, char *out, size_t out_len)
{
    if (!json || !key || !out || out_len == 0) {
        return false;
    }

    char pattern[32];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    const char *p = strstr(json, pattern);
    if (!p) return false;
    p = strchr(p + strlen(pattern), ':');
    if (!p) return false;
    p++;
    while (*p == ' ' || *p == '\t') p++;
    if (*p != '"') return false;
    p++;
    const char *end = strchr(p, '"');
    if (!end) return false;
    size_t len = end - p;
    if (len >= out_len) len = out_len - 1;
    memcpy(out, p, len);
    out[len] = '\0';
    return true;
}

static bool json_get_int(const char *json, const char *key, int *out)
{
    if (!json || !key || !out) return false;
    char pattern[32];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    const char *p = strstr(json, pattern);
    if (!p) return false;
    p = strchr(p + strlen(pattern), ':');
    if (!p) return false;
    p++;
    while (*p == ' ' || *p == '\t') p++;
    *out = atoi(p);
    return true;
}

static bool json_get_bool(const char *json, const char *key, bool *out)
{
    if (!json || !key || !out) return false;
    char pattern[32];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    const char *p = strstr(json, pattern);
    if (!p) return false;
    p = strchr(p + strlen(pattern), ':');
    if (!p) return false;
    p++;
    while (*p == ' ' || *p == '\t') p++;
    if (strncmp(p, "true", 4) == 0) {
        *out = true;
        return true;
    }
    if (strncmp(p, "false", 5) == 0) {
        *out = false;
        return true;
    }
    return false;
}

static int gpio_from_device(const char *device)
{
    if (!device || device[0] != 'D') {
        return -1;
    }
    int gpio = atoi(device + 1);
    return gpio > 0 ? gpio : -1;
}

static void send_command_ack(const char *command, const char *device, bool state, bool success)
{
    String msg = "{\"type\":\"ack\",\"command\":\"";
    msg += command ? command : "";
    msg += "\",\"device\":\"";
    msg += device ? device : "";
    msg += "\",\"state\":";
    msg += state ? "true" : "false";
    msg += ",\"success\":";
    msg += success ? "true" : "false";
    msg += "}";
    send_ws_text(msg.c_str());
}

static void handle_server_text(const char *text)
{
    if (text && text[0] == '{') {
        char type[24];
        if (json_get_string(text, "type", type, sizeof(type))) {
            if (strcmp(type, "stop_capture") == 0) {
                voice_capture_active = false;
                wake_paused_by_server = true;
                reset_inference_buffer();
                reset_voice_filter();
                wake_hits = 0;
                digitalWrite(LED_MIC, LOW);
                led_mic_until_ms = 0;
                Serial.println("MIC: tat mic, doi server xu ly xong");
                return;
            }
            if (strcmp(type, "rearm_wake") == 0 || strcmp(type, "server_ready") == 0) {
                voice_capture_active = false;
                wake_paused_by_server = false;
                reset_inference_buffer();
                reset_voice_filter();
                wake_hits = 0;
                last_wake_ms = millis() - WAKE_COOLDOWN_MS;
                wake_ready_notice_pending = true;
                digitalWrite(LED_MIC, LOW);
                led_mic_until_ms = 0;
                return;
            }
            if (strcmp(type, "not_clear") == 0) {
                char reason[48] = "";
                json_get_string(text, "reason", reason, sizeof(reason));
                led_warn_pulse_until_ms = millis() + WARN_VISIBLE_MS;
                digitalWrite(LED_WARN, HIGH);
                Serial.print("MIC: khong nghe ro lenh, LED_WARN, reason=");
                Serial.println(reason);
                return;
            }
            if (strcmp(type, "command") == 0) {
                apply_json_command(text);
                return;
            }
        }
    }

    if (strcmp(text, "VOICE_STOP_CAPTURE") == 0) {
        voice_capture_active = false;
        wake_paused_by_server = true;
        reset_inference_buffer();
        reset_voice_filter();
        wake_hits = 0;
        digitalWrite(LED_MIC, LOW);
        led_mic_until_ms = 0;
        Serial.println("MIC: tat mic, doi server xu ly xong");
        return;
    }

    if (strcmp(text, "WAKE_REARM") == 0 || strcmp(text, "VOICE_DONE") == 0) {
        voice_capture_active = false;
        wake_paused_by_server = false;
        reset_inference_buffer();
        reset_voice_filter();
        wake_hits = 0;
        last_wake_ms = millis() - WAKE_COOLDOWN_MS;
        wake_ready_notice_pending = true;
        digitalWrite(LED_MIC, LOW);
        led_mic_until_ms = 0;
        Serial.println("WAKE: khoi dong lai wake model");
        return;
    }

    if (strcmp(text, "VOICE_NOT_CLEAR") == 0) {
        led_warn_pulse_until_ms = millis() + WARN_VISIBLE_MS;
        digitalWrite(LED_WARN, HIGH);
        Serial.println("MIC: khong nghe ro lenh, nhay LED_WARN");
        return;
    }

    apply_light_command(text);
}

static void apply_light_command(const char *cmd)
{
    char device[12];
    char action[8];
    const char *sep = strchr(cmd, '_');
    if (!sep) return;
    size_t dev_len = sep - cmd;
    if (dev_len == 0 || dev_len >= sizeof(device)) return;
    memcpy(device, cmd, dev_len);
    device[dev_len] = '\0';
    strncpy(action, sep + 1, sizeof(action) - 1);
    action[sizeof(action) - 1] = '\0';

    int gpio = gpio_from_device(device);
    if (gpio < 0) {
        send_command_ack(cmd, device, false, false);
        return;
    }

    bool state = strcmp(action, "ON") == 0;
    if (!state && strcmp(action, "OFF") != 0) {
        send_command_ack(cmd, device, false, false);
        return;
    }

    pinMode(gpio, OUTPUT);
    digitalWrite(gpio, state ? HIGH : LOW);
    send_command_ack(cmd, device, state, true);
}

static void apply_json_command(const char *json)
{
    char command[24] = "";
    char device[12] = "";
    int gpio = -1;
    bool state = false;

    json_get_string(json, "command", command, sizeof(command));
    json_get_string(json, "device", device, sizeof(device));
    json_get_int(json, "gpio", &gpio);
    json_get_bool(json, "state", &state);

    if (gpio < 0 && device[0] != '\0') {
        gpio = gpio_from_device(device);
    }
    if (device[0] == '\0' && gpio >= 0) {
        snprintf(device, sizeof(device), "D%d", gpio);
    }
    if (command[0] == '\0' && device[0] != '\0') {
        snprintf(command, sizeof(command), "%s_%s", device, state ? "ON" : "OFF");
    }

    if (gpio < 0) {
        send_command_ack(command, device, state, false);
        return;
    }

    pinMode(gpio, OUTPUT);
    digitalWrite(gpio, state ? HIGH : LOW);
    send_command_ack(command, device, state, true);
}

static void handle_wake_word_result(ei_impulse_result_t *result)
{
    if (voice_capture_active) {
        return;
    }

    float wake_score = 0.0f;
    float noise_score = 0.0f;
    float other_score = 0.0f;
    float max_non_wake_score = 0.0f;

    for (size_t ix = 0; ix < EI_CLASSIFIER_LABEL_COUNT; ix++) {
        const char *label = result->classification[ix].label;
        float value = result->classification[ix].value;

        bool is_wake_label = WAKE_LABEL[0] != '\0'
            ? strcmp(label, WAKE_LABEL) == 0
            : (strcmp(label, "noise") != 0 && strcmp(label, "other") != 0);

        if (is_wake_label) {
            if (value > wake_score) {
                wake_score = value;
            }
        }
        else if (strcmp(label, "noise") == 0) {
            noise_score = value;
            if (value > max_non_wake_score) {
                max_non_wake_score = value;
            }
        }
        else if (strcmp(label, "other") == 0) {
            other_score = value;
            if (value > max_non_wake_score) {
                max_non_wake_score = value;
            }
        }
        else if (value > max_non_wake_score) {
            max_non_wake_score = value;
        }
    }

    bool confident = wake_score >= WAKE_THRESHOLD;

    if (confident) {
        if (wake_hits < 255) {
            wake_hits++;
        }
    }
    else {
        wake_hits = 0;
    }

    uint32_t now = millis();

    if (DEBUG_WAKE_SCORE_LOG && wake_score >= WAKE_SCORE_LOG_MIN &&
        now - last_wake_score_log_ms >= WAKE_SCORE_LOG_MS) {
        last_wake_score_log_ms = now;
        Serial.printf("WAKE_SCORE: %s=%.2f threshold=%.2f noise=%.2f other=%.2f\n",
            WAKE_LABEL, wake_score, WAKE_THRESHOLD, noise_score, other_score);
    }

    if (confident && wake_hits >= WAKE_HITS_REQUIRED && now - last_wake_ms >= WAKE_COOLDOWN_MS) {
        Serial.printf("WAKE: detected %s=%.2f threshold=%.2f\n", WAKE_LABEL, wake_score, WAKE_THRESHOLD);
        last_wake_ms = now;
        wake_hits = 0;
        start_voice_capture();
    }
}

static void update_status_leds(void)
{
    if (led_warn_pulse_until_ms != 0 && millis() >= led_warn_pulse_until_ms) {
        led_warn_pulse_until_ms = 0;
        digitalWrite(LED_WARN, ws_connected ? LOW : HIGH);
    }

    if (voice_capture_active) {
        digitalWrite(LED_MIC, HIGH);
        return;
    }

    if (led_mic_until_ms != 0 && millis() >= led_mic_until_ms) {
        digitalWrite(LED_MIC, LOW);
        led_mic_until_ms = 0;
    }
}

static void audio_inference_callback(uint32_t n_bytes)
{
    for(int i = 0; i < n_bytes>>1; i++) {
        inference.buffers[inference.buf_select][inference.buf_count++] = sampleBuffer[i];

        if(inference.buf_count >= inference.n_samples) {
            inference.buf_select ^= 1;
            inference.buf_count = 0;
            inference.buf_ready = 1;
        }
    }
}

static void capture_samples(void* arg) {

  const int32_t frames_to_read = (uint32_t)arg;
  const int32_t i2s_bytes_to_read = frames_to_read * sizeof(int32_t);
  size_t bytes_read = 0;

  while (record_status) {

    /* read data at once from i2s */
    i2s_read(I2S_PORT, (void*)i2sRawBuffer, i2s_bytes_to_read, &bytes_read, 100);

    if (bytes_read <= 0) {
      ei_printf("Error in I2S read : %d", bytes_read);
    }
    else {
        if (bytes_read < i2s_bytes_to_read) {
        ei_printf("Partial I2S read");
        }

        int32_t samples_read = bytes_read / sizeof(int32_t);

        // INMP441 sends 24-bit audio in a 32-bit I2S slot. Convert to int16 for EI.
        for (int x = 0; x < samples_read; x++) {
            int32_t raw_sample = i2sRawBuffer[x] >> I2S_SAMPLE_SHIFT;
            int32_t amplified = raw_sample * AUDIO_GAIN;
            if (amplified > 32767) {
                amplified = 32767;
            }
            else if (amplified < -32768) {
                amplified = -32768;
            }
            sampleBuffer[x] = (int16_t)amplified;
            if (voice_capture_active) {
                voiceSendBuffer[x] = process_voice_stream_sample(raw_sample);
            }
        }

        if (record_status) {
            if (!voice_capture_active && !wake_paused_by_server) {
                audio_inference_callback(samples_read * sizeof(int16_t));
            }
            if (voice_capture_active && ws_connected) {
                webSocket.sendBIN((uint8_t *)voiceSendBuffer, samples_read * sizeof(int16_t));
            }
        }
        else {
            break;
        }
    }
  }
  vTaskDelete(NULL);
}

/**
 * @brief      Init inferencing struct and setup/start PDM
 *
 * @param[in]  n_samples  The n samples
 *
 * @return     { description_of_the_return_value }
 */
static bool microphone_inference_start(uint32_t n_samples)
{
    inference.buffers[0] = (signed short *)malloc(n_samples * sizeof(signed short));

    if (inference.buffers[0] == NULL) {
        return false;
    }

    inference.buffers[1] = (signed short *)malloc(n_samples * sizeof(signed short));

    if (inference.buffers[1] == NULL) {
        ei_free(inference.buffers[0]);
        return false;
    }

    inference.buf_select = 0;
    inference.buf_count = 0;
    inference.n_samples = n_samples;
    inference.buf_ready = 0;

    if (i2s_init(EI_CLASSIFIER_FREQUENCY)) {
        ei_printf("Failed to start I2S!");
        return false;
    }

    ei_sleep(100);

    record_status = true;

    xTaskCreate(capture_samples, "CaptureSamples", 1024 * 32, (void*)sample_buffer_size, 10, NULL);

    return true;
}

/**
 * @brief      Wait on new data
 *
 * @return     True when finished
 */
static bool microphone_inference_record(void)
{
    bool ret = true;

    if (inference.buf_ready == 1) {
        reset_inference_buffer();
        delay(2);
        return true;
    }

    while (inference.buf_ready == 0) {
        service_network();
        update_status_leds();
        delay(1);
    }

    inference.buf_ready = 0;
    return ret;
}

/**
 * Get raw audio signal data
 */
static int microphone_audio_signal_get_data(size_t offset, size_t length, float *out_ptr)
{
    numpy::int16_to_float(&inference.buffers[inference.buf_select ^ 1][offset], out_ptr, length);

    return 0;
}

/**
 * @brief      Stop PDM and release buffers
 */
static void microphone_inference_end(void)
{
    i2s_deinit();
    ei_free(inference.buffers[0]);
    ei_free(inference.buffers[1]);
}


static int i2s_init(uint32_t sampling_rate) {
  // Start listening for audio: MONO @ model frequency.
  i2s_config_t i2s_config = {
      .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
      .sample_rate = sampling_rate,
      .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
      .channel_format = I2S_MIC_CHANNEL,
      .communication_format = I2S_COMM_FORMAT_I2S,
      .intr_alloc_flags = 0,
      .dma_buf_count = 8,
      .dma_buf_len = 512,
      .use_apll = false,
      .tx_desc_auto_clear = false,
      .fixed_mclk = -1,
  };
  i2s_pin_config_t pin_config = {
      .bck_io_num = I2S_SCK,
      .ws_io_num = I2S_WS,
      .data_out_num = -1,
      .data_in_num = I2S_SD,
  };
  esp_err_t ret = 0;

  ret = i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
  if (ret != ESP_OK) {
    ei_printf("Error in i2s_driver_install");
    return int(ret);
  }

  ret = i2s_set_pin(I2S_PORT, &pin_config);
  if (ret != ESP_OK) {
    ei_printf("Error in i2s_set_pin");
    return int(ret);
  }

  ret = i2s_zero_dma_buffer(I2S_PORT);
  if (ret != ESP_OK) {
    ei_printf("Error in initializing dma buffer with 0");
    return int(ret);
  }

  return int(ret);
}

static int i2s_deinit(void) {
    i2s_driver_uninstall(I2S_PORT); //stop & destroy i2s driver
    return 0;
}

#if !defined(EI_CLASSIFIER_SENSOR) || EI_CLASSIFIER_SENSOR != EI_CLASSIFIER_SENSOR_MICROPHONE
#error "Invalid model for current sensor."
#endif
