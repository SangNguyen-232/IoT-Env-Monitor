#include "task_webserver.h"
#include <WiFi.h>
#include <esp_system.h>
#include <mbedtls/md.h>
#include <mbedtls/base64.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <vector>
#include "pump.h"
#include "global.h"
#include "task_check_info.h"
#include "secrets.h"

#ifndef OTA_HTTP_USER
#define OTA_HTTP_USER DEVICE_HTTP_USER
#endif
#ifndef OTA_HTTP_PASS
#define OTA_HTTP_PASS DEVICE_HTTP_PASS
#endif
 
static bool isAPMode()
{
    return (WiFi.getMode() == WIFI_AP) || (WiFi.getMode() == WIFI_AP_STA && WiFi.status() != WL_CONNECTED);
}
 
// Verify HMAC-SHA256 ticket do backend cấp (mục 3B).
// ticket là base64url(JSON{payload,sig}).
// payload = "<device_id>:<lan_ip>:<expiresAt_ms>"
// sig = HMAC-SHA256(SENSOR_API_KEY, payload) hex
static bool verifyTicket(const String &ticketB64)
{
    // Giới hạn kích thước đầu vào để tránh cấp phát bộ nhớ quá lớn trên ESP32.
    if (ticketB64.isEmpty() || ticketB64.length() > 1400) return false;

    // Chuyển Base64URL sang Base64 chuẩn.
    String b64 = ticketB64;
    b64.replace('-', '+');
    b64.replace('_', '/');
    if (b64.length() % 4 == 1) return false;
    while (b64.length() % 4 != 0) b64 += '=';

    // Dùng API Mbed TLS đi kèm framework ESP32 (không dùng base64::decode).
    std::vector<unsigned char> decodedBuf((b64.length() * 3) / 4 + 1);
    size_t decodedLen = 0;
    int ret = mbedtls_base64_decode(
        decodedBuf.data(),
        decodedBuf.size() - 1,
        &decodedLen,
        reinterpret_cast<const unsigned char *>(b64.c_str()),
        b64.length()
    );
    if (ret != 0 || decodedLen == 0) return false;
    decodedBuf[decodedLen] = '\0';

    // Parse JSON đúng chuẩn, không tìm trường bằng thao tác chuỗi thủ công.
    StaticJsonDocument<512> doc;
    if (deserializeJson(doc, reinterpret_cast<const char *>(decodedBuf.data()), decodedLen)
            != DeserializationError::Ok) return false;

    const char *payloadText = doc["payload"];
    const char *sigText = doc["sig"];
    if (payloadText == nullptr || sigText == nullptr) return false;

    String payload(payloadText);
    String sigHex(sigText);
    if (payload.isEmpty() || sigHex.length() != 64) return false;

    // Ticket phải được cấp cho đúng thiết bị này (device_id = MAC, khớp task_database.cpp).
    if (!payload.startsWith(WiFi.macAddress() + ":")) return false;

    // Payload có dạng: <device_id>:<lan_ip>:<expiresAt_ms>.
    const int firstColon = payload.indexOf(':');
    const int lastColon = payload.lastIndexOf(':');
    if (firstColon <= 0 || lastColon <= firstColon + 1 ||
        lastColon >= static_cast<int>(payload.length()) - 1) return false;

    const String expiresText = payload.substring(lastColon + 1);
    errno = 0;
    char *endPtr = nullptr;
    const long long expiresAtMs = strtoll(expiresText.c_str(), &endPtr, 10);
    if (errno == ERANGE || endPtr == expiresText.c_str() ||
        endPtr == nullptr || *endPtr != '\0' || expiresAtMs <= 0) return false;

    // Từ chối khi chưa đồng bộ thời gian: nếu không có giờ tin cậy,
    // ESP32 không thể kiểm tra ticket đã hết hạn hay chưa.
    const time_t nowSec = time(nullptr);
    if (nowSec < static_cast<time_t>(1577836800)) return false; // 2020-01-01 UTC
    const long long nowMs = static_cast<long long>(nowSec) * 1000LL;
    if (nowMs >= expiresAtMs) return false;

    // Kiểm tra HMAC-SHA256 với khóa chia sẻ giữa ESP32 và backend.
    const char *key = SENSOR_API_KEY;
    if (key == nullptr || key[0] == '\0') return false;

    const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    if (info == nullptr) return false;

    unsigned char hmacOut[32];
    mbedtls_md_context_t ctx_md;
    mbedtls_md_init(&ctx_md);
    bool hmacOk = false;
    if (mbedtls_md_setup(&ctx_md, info, 1) == 0 &&
        mbedtls_md_hmac_starts(&ctx_md,
            reinterpret_cast<const unsigned char *>(key), strlen(key)) == 0 &&
        mbedtls_md_hmac_update(&ctx_md,
            reinterpret_cast<const unsigned char *>(payload.c_str()), payload.length()) == 0 &&
        mbedtls_md_hmac_finish(&ctx_md, hmacOut) == 0)
    {
        hmacOk = true;
    }
    mbedtls_md_free(&ctx_md);
    if (!hmacOk) return false;

    char expected[65];
    for (int i = 0; i < 32; ++i) {
        snprintf(expected + i * 2, 3, "%02x", hmacOut[i]);
    }
    expected[64] = '\0';

    // Chỉ chấp nhận chữ ký đúng 64 ký tự hex; so sánh không dừng sớm.
    uint8_t diff = 0;
    for (int i = 0; i < 64; ++i) {
        diff |= static_cast<uint8_t>(expected[i] ^ sigHex[i]);
    }
    return diff == 0;
}

static bool requireDeviceAuth(AsyncWebServerRequest *request)
{
    // Ở chế độ AP Mode: mạng đã có mật khẩu Wi-Fi AP (WPA2).
    // Bỏ qua Basic Auth để Apple Captive Assistant trên iPhone không bị chặn màn hình trắng.
    if (isAPMode()) return true;
 
    if (!request->authenticate(DEVICE_HTTP_USER, DEVICE_HTTP_PASS))
    {
        request->requestAuthentication();
        return false;
    }
    return true;
}
 
AsyncWebServer server(80);
AsyncWebSocket ws("/ws");
 
bool webserver_isrunning = false;
 
String global_pump_state = "OFF"; 
String global_pump_mode = "AUTO"; 
String global_admin_ip = "";
 
static SharedContext* s_ctx = nullptr;

static String s_wsToken = "";
static unsigned long s_wsTokenUntil = 0;
static uint32_t s_wsAuthIds[8] = {0};

static bool wsIsAuth(uint32_t id)
{
    for (int i = 0; i < 8; i++) if (s_wsAuthIds[i] == id) return true;
    return false;
}

static void wsSetAuth(uint32_t id, bool on)
{
    for (int i = 0; i < 8; i++) if (s_wsAuthIds[i] == id) s_wsAuthIds[i] = 0;
    if (!on) return;
    for (int i = 0; i < 8; i++) if (s_wsAuthIds[i] == 0) { s_wsAuthIds[i] = id; return; }
}
 
void Webserver_init_ctx(SharedContext* ctx)
{
    s_ctx = ctx;
}
 
void Webserver_sendata(String data)
{
    if (ws.count() > 0)
    {
        ws.textAll(data);
    }
}
 
static void captureAdminIp(AsyncWebServerRequest *request)
{
    String ip = request->client()->remoteIP().toString();
    if (!ip.isEmpty() && ip != "0.0.0.0")
    {
        global_admin_ip = ip;
    }
}
 
void onEvent(AsyncWebSocket *server, AsyncWebSocketClient *client, AwsEventType type, void *arg, uint8_t *data, size_t len)
{
    if (type == WS_EVT_CONNECT)
    {
        String ip = client->remoteIP().toString();
        if (!ip.isEmpty() && ip != "0.0.0.0")
        {
            global_admin_ip = ip;
        }
        Serial.printf("WebSocket client #%u connected from %s\n", client->id(), client->remoteIP().toString().c_str());
 
        String pumpState, pumpMode;
        if (xSemaphoreTake(xMutexPumpControl, pdMS_TO_TICKS(200)) == pdTRUE) {
            pumpState = global_pump_state;
            pumpMode  = global_pump_mode;
            xSemaphoreGive(xMutexPumpControl);
        }
        String initMsg = "{\"pump_state\":\"" + pumpState + "\",\"pump_mode\":\"" + pumpMode + "\"}";
        client->text(initMsg);
    }
    else if (type == WS_EVT_DISCONNECT)
    {
        wsSetAuth(client->id(), false);
        Serial.printf("WebSocket client #%u disconnected\n", client->id());
    }
    else if (type == WS_EVT_DATA)
    {
        AwsFrameInfo *info = (AwsFrameInfo *)arg;
 
        if (info->opcode == WS_TEXT)
        {
            String message;
            message += String((char *)data).substring(0, len);

            DynamicJsonDocument hdr(1024);
            if (deserializeJson(hdr, message) != DeserializationError::Ok) return;
            String page = hdr["page"] | String("");
            if (page == "auth")
            {
                String tk = hdr["token"] | String("");
                if (!s_wsToken.isEmpty() && tk == s_wsToken && (long)(millis() - s_wsTokenUntil) < 0)
                {
                    wsSetAuth(client->id(), true);
                    s_wsToken = "";
                }
                return;
            }
            if (!wsIsAuth(client->id())) return;
            handleWebSocketMessage(message);
        }
    }
}
 
void connnectWSV()
{
    ws.onEvent(onEvent);
    server.addHandler(&ws);
 
    // Route GET / luôn yêu cầu Basic Auth (không dùng ticket).
    server.on("/", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (!requireDeviceAuth(request)) return;
        request->send(LittleFS, "/dashboard.html", "text/html");
    });

    // Không cho phép /dashboard.html truy cập trực tiếp mà bỏ qua Basic Auth.
    // Ticket chỉ được xử lý tại route "/" phía trên.
    server.on("/dashboard.html", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (!requireDeviceAuth(request)) return;
        request->send(LittleFS, "/dashboard.html", "text/html");
    });

    server.serveStatic("/", LittleFS, "/")
        .setDefaultFile("dashboard.html")
        .setFilter([](AsyncWebServerRequest *request) {
            String u = request->url();
            u.toLowerCase();
            return !(u == "/dashboard.html" ||
                     u.indexOf("info.dat") >= 0 ||
                     u.indexOf("wifi_list.json") >= 0 ||
                     u.indexOf("wifi_info.json") >= 0 ||
                     u.indexOf("server.json") >= 0);
        });
 
    server.on("/api/status", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (!requireDeviceAuth(request)) return;
        captureAdminIp(request);
        bool is_ap_mode = (WiFi.getMode() == WIFI_AP) || (WiFi.getMode() == WIFI_AP_STA && WiFi.status() != WL_CONNECTED);
        String json = "{\"mqtt_connected\": false, \"is_ap_mode\": " + String(is_ap_mode ? "true" : "false") + "}"; 
        request->send(200, "application/json", json);
    });

    server.on("/api/ws-token", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (!requireDeviceAuth(request)) return;
        captureAdminIp(request);
        char buf[33];
        snprintf(buf, sizeof(buf), "%08x%08x%08x%08x",
                 (unsigned)esp_random(), (unsigned)esp_random(),
                 (unsigned)esp_random(), (unsigned)esp_random());
        s_wsToken = String(buf);
        s_wsTokenUntil = millis() + 30000UL;
        request->send(200, "application/json", "{\"token\":\"" + s_wsToken + "\"}");
    });
 
    server.on("/toggle-pump", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (!requireDeviceAuth(request)) return;
        captureAdminIp(request);
        String temp_state;
        bool has_param = request->hasParam("state");
        if (has_param) {
            temp_state = request->getParam("state")->value();
            temp_state.toUpperCase();
        }
 
        String current_state, current_mode;
        if (xSemaphoreTake(xMutexPumpControl, portMAX_DELAY) == pdTRUE) {
            if (has_param) {
                global_pump_state = temp_state;
            } else {
                global_pump_state = (global_pump_state == "ON") ? "OFF" : "ON";
            }
            
            global_pump_mode = "MANUAL";
            pump_manual_control = true;
            pump_manual_state = (global_pump_state == "ON");
 
            current_state = global_pump_state;
            current_mode = global_pump_mode;
            xSemaphoreGive(xMutexPumpControl);
        }
 
        Webserver_sendata("{\"pump_state\":\"" + current_state + "\",\"pump_mode\":\"" + current_mode + "\"}");
 
        if (s_ctx != nullptr) xSemaphoreGive(s_ctx->semDBUpdate);
 
        request->send(200, "text/plain", current_state);
    });
 
    server.on("/set-mode", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (!requireDeviceAuth(request)) return;
        captureAdminIp(request);
        String temp_mode;
        bool has_param = request->hasParam("mode");
        if (has_param) {
            temp_mode = request->getParam("mode")->value();
            temp_mode.toUpperCase();
        }
 
        String current_state, current_mode;
        if (xSemaphoreTake(xMutexPumpControl, portMAX_DELAY) == pdTRUE) {
            if (has_param) {
                global_pump_mode = temp_mode;
            } else {
                global_pump_mode = (global_pump_mode == "MANUAL") ? "AUTO" : "MANUAL";
            }
 
            pump_manual_control = (global_pump_mode == "MANUAL");
            if (pump_manual_control) {
                pump_manual_state = (global_pump_state == "ON");
            }
 
            current_state = global_pump_state;
            current_mode = global_pump_mode;
            xSemaphoreGive(xMutexPumpControl);
        }
 
        Webserver_sendata("{\"pump_state\":\"" + current_state + "\",\"pump_mode\":\"" + current_mode + "\"}");
 
        if (s_ctx != nullptr) xSemaphoreGive(s_ctx->semDBUpdate);
 
        request->send(200, "text/plain", current_mode);
    });
 
    server.on("/api/wifi-list", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (!requireDeviceAuth(request)) return;
        captureAdminIp(request);
        DynamicJsonDocument src(1024);
        Load_wifi_list(src);
        DynamicJsonDocument outDoc(1024);
        JsonArray arr = outDoc.to<JsonArray>();
        if (src.is<JsonArray>()) {
            for (JsonObject item : src.as<JsonArray>()) {
                JsonObject o = arr.createNestedObject();
                o["ssid"] = item["ssid"];
            }
        }
        String out;
        serializeJson(outDoc, out);
        request->send(200, "application/json", out);
    });
 
    server.on("/api/server-url", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (!requireDeviceAuth(request)) return;
        captureAdminIp(request);
        DynamicJsonDocument doc(256);
        doc["url"] = g_sensorApiUrl;
        String out;
        serializeJson(doc, out);
        request->send(200, "application/json", out);
    });
 
    server.on("/api/server-url", HTTP_POST,
        [](AsyncWebServerRequest *request) {},
        nullptr,
        [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
            if (!requireDeviceAuth(request)) return;
            static String bodyBuf;
            if (index == 0) bodyBuf = "";
            for (size_t i = 0; i < len; i++) bodyBuf += (char)data[i];
            if (index + len < total) return;
 
            StaticJsonDocument<512> doc;
            if (deserializeJson(doc, bodyBuf) != DeserializationError::Ok) {
                request->send(400, "application/json", "{\"error\":\"invalid json\"}");
                return;
            }
            String url = doc["url"] | String("");
            url.trim();
            if (url.isEmpty() || !(url.startsWith("http://") || url.startsWith("https://"))) {
                request->send(400, "application/json", "{\"error\":\"url required\"}");
                return;
            }
            Save_server_url(url);
            captureAdminIp(request);
            request->send(200, "application/json", "{\"ok\":true}");
        }
    );
 
    server.on("/api/wifi-switch", HTTP_POST,
        [](AsyncWebServerRequest *request) {},
        nullptr,
        [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
            if (!requireDeviceAuth(request)) return;
            static String bodyBuf;
            if (index == 0) bodyBuf = "";
            for (size_t i = 0; i < len; i++) bodyBuf += (char)data[i];
            if (index + len < total) return;
 
            StaticJsonDocument<256> doc;
            if (deserializeJson(doc, bodyBuf) != DeserializationError::Ok) {
                request->send(400, "application/json", "{\"error\":\"invalid json\"}");
                return;
            }
            String ssid = doc["ssid"] | String("");
            String pass = doc["pass"] | String("");
            if (ssid.isEmpty()) {
                request->send(400, "application/json", "{\"error\":\"ssid required\"}");
                return;
            }
            if (pass.isEmpty()) {
                Lookup_wifi_pass(ssid, pass);
            }
            g_wifiSwitchSSID = ssid;
            g_wifiSwitchPass = pass;
            g_wifiSwitchFlag = true;
            captureAdminIp(request);
            request->send(200, "application/json", "{\"ok\":true}");
        }
    );
 
    // Captive Portal Redirect Endpoints cho iOS, Android, Windows
    auto captiveRedirect = [](AsyncWebServerRequest *request) {
        request->redirect("http://192.168.4.1/");
    };
    server.on("/hotspot-detect.html", HTTP_GET, captiveRedirect);
    server.on("/generate_204", HTTP_GET, captiveRedirect);
    server.on("/gen_204", HTTP_GET, captiveRedirect);
    server.on("/ncsi.txt", HTTP_GET, captiveRedirect);
    server.on("/connecttest.txt", HTTP_GET, captiveRedirect);
    server.on("/redirect", HTTP_GET, captiveRedirect);
    server.on("/canonical.html", HTTP_GET, captiveRedirect);
    server.on("/success.txt", HTTP_GET, captiveRedirect);
 
    server.onNotFound([](AsyncWebServerRequest *request) {
        String url = request->url();
        if (url.endsWith(".ico") || url.endsWith(".png") || url.endsWith(".jpg") || 
            url.endsWith(".css") || url.endsWith(".js") || url.endsWith(".map") ||
            url == "/" || url == "/dashboard.html") {
            request->send(404, "text/plain", "Not found");
            return;
        }
        if (isAPMode()) {
            request->redirect("http://192.168.4.1/");
        } else {
            request->send(404, "text/plain", "Not found");
        }
    });
 
    server.begin();
    ElegantOTA.begin(&server, OTA_HTTP_USER, OTA_HTTP_PASS);
    webserver_isrunning = true;
}
 
void Webserver_stop()
{
    ws.closeAll();
    server.end();
    webserver_isrunning = false;
}
 
void Webserver_reconnect()
{
    if (!webserver_isrunning)
    {
        connnectWSV();
    }
    ElegantOTA.loop();
}