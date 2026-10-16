#include "web/web_server.h"
#include <WiFi.h>
#include <esp_system.h>
#include <mbedtls/md.h>
#include <mbedtls/base64.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <vector>
#include "control/pump.h"
#include "app/shared_context.h"
#include "storage/device_config.h"
#include "config/secrets.h"
#include "domain/input_safety.h"
#include <AsyncJson.h>

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
static bool verifyTicket(const String &ticketB64, long long *validUntilMs = nullptr)
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
    JsonDocument doc;
    if (deserializeJson(doc, reinterpret_cast<const char *>(decodedBuf.data()), decodedLen)
            != DeserializationError::Ok) return false;

    const char *payloadText = doc["payload"];
    const char *sigText = doc["sig"];
    if (payloadText == nullptr || sigText == nullptr) return false;

    String payload(payloadText);
    String sigHex(sigText);
    if (payload.isEmpty() || sigHex.length() != 64) return false;

    // Bind both MAC and the LAN address covered by the backend permission grant.
    const String prefix = WiFi.macAddress() + ":" + WiFi.localIP().toString() + ":";
    if (!payload.startsWith(prefix)) return false;
    const String expiresText = payload.substring(prefix.length());
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
    if (diff != 0) return false;
    if (validUntilMs != nullptr) *validUntilMs = expiresAtMs;
    return true;
}

static bool requireDeviceAuth(AsyncWebServerRequest *request, uint32_t *maxWsSessionMs = nullptr)
{
    if (maxWsSessionMs != nullptr) *maxWsSessionMs = 300000U;
    // Ở chế độ AP Mode: mạng đã có mật khẩu Wi-Fi AP (WPA2).
    // Bỏ qua Basic Auth để Apple Captive Assistant trên iPhone không bị chặn màn hình trắng.
    if (isAPMode()) return true;

    if (request->hasHeader("Cookie")) {
        const String cookies = request->getHeader("Cookie")->value();
        int start = 0;
        while (start < static_cast<int>(cookies.length())) {
            int end = cookies.indexOf(';', start);
            if (end < 0) end = cookies.length();
            String part = cookies.substring(start, end);
            part.trim();
            long long expiresAtMs = 0;
            if (part.startsWith("iot_ticket=") && verifyTicket(part.substring(11), &expiresAtMs)) {
                const long long remainingMs = expiresAtMs - static_cast<long long>(time(nullptr)) * 1000LL;
                if (remainingMs > 0) {
                    if (maxWsSessionMs != nullptr)
                        *maxWsSessionMs = remainingMs < 300000LL ? static_cast<uint32_t>(remainingMs) : 300000U;
                    return true;
                }
            }
            start = end + 1;
        }
    }
 
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
 
static SharedContext* s_ctx = nullptr;

static String s_wsToken = "";
static unsigned long s_wsTokenUntil = 0;
static uint32_t s_wsSessionUntil = 0;
static uint32_t s_wsAuthIds[8] = {0};
static uint32_t s_wsAuthUntil[8] = {0};
static portMUX_TYPE s_wsAuthMux = portMUX_INITIALIZER_UNLOCKED;

static bool wsIsAuth(uint32_t id)
{
    bool authorized = false;
    const uint32_t now = millis();
    portENTER_CRITICAL(&s_wsAuthMux);
    for (int i = 0; i < 8; i++)
        if (s_wsAuthIds[i] == id) authorized = static_cast<int32_t>(now - s_wsAuthUntil[i]) < 0;
    portEXIT_CRITICAL(&s_wsAuthMux);
    return authorized;
}

static void wsSetAuth(uint32_t id, bool on)
{
    portENTER_CRITICAL(&s_wsAuthMux);
    for (int i = 0; i < 8; i++) if (s_wsAuthIds[i] == id) s_wsAuthIds[i] = 0;
    if (on) for (int i = 0; i < 8; i++) if (s_wsAuthIds[i] == 0) {
        s_wsAuthUntil[i] = s_wsSessionUntil;
        s_wsAuthIds[i] = id;
        break;
    }
    portEXIT_CRITICAL(&s_wsAuthMux);
}
 
void Webserver_init_ctx(SharedContext* ctx)
{
    s_ctx = ctx;
}
 
void Webserver_sendata(String data)
{
    uint32_t ids[8];
    portENTER_CRITICAL(&s_wsAuthMux);
    memcpy(ids, s_wsAuthIds, sizeof(ids));
    portEXIT_CRITICAL(&s_wsAuthMux);
    // Send by ID through the library's locked API; never iterate its client list
    // from a sensor/control task while AsyncTCP can add/remove clients.
    for (uint32_t id : ids) {
        if (id == 0) continue;
        if (wsIsAuth(id)) ws.text(id, data);
        else {
            ws.close(id, 4001, "authentication expired");
            wsSetAuth(id, false);
        }
    }
}
 
void onEvent(AsyncWebSocket *server, AsyncWebSocketClient *client, AwsEventType type, void *arg, uint8_t *data, size_t len)
{
    if (type == WS_EVT_CONNECT)
    {
        Serial.printf("WebSocket client #%u connected from %s\n", client->id(), client->remoteIP().toString().c_str());
 
    }
    else if (type == WS_EVT_DISCONNECT)
    {
        wsSetAuth(client->id(), false);
        Serial.printf("WebSocket client #%u disconnected\n", client->id());
    }
    else if (type == WS_EVT_DATA)
    {
        AwsFrameInfo *info = (AwsFrameInfo *)arg;
 
        if (info != nullptr && info->opcode == WS_TEXT &&
            websocket_frame_is_complete(info->final, info->index, info->len, len))
        {
            String message;
            if (!message.concat(reinterpret_cast<const char *>(data), len)) return;

            JsonDocument hdr;
            if (deserializeJson(hdr, message) != DeserializationError::Ok) return;
            String page = hdr["page"] | String("");
            if (page == "auth")
            {
                String tk = hdr["token"] | String("");
                if (!s_wsToken.isEmpty() && tk == s_wsToken && (long)(millis() - s_wsTokenUntil) < 0)
                {
                    wsSetAuth(client->id(), true);
                    s_wsToken = "";
                    if (wsIsAuth(client->id()) && xSemaphoreTake(xMutexPumpControl, pdMS_TO_TICKS(200)) == pdTRUE) {
                        String initMsg = "{\"pump_state\":\"" + global_pump_state + "\",\"pump_mode\":\"" + global_pump_mode + "\"}";
                        xSemaphoreGive(xMutexPumpControl);
                        client->text(initMsg);
                    }
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
 
    // Exchange the short-lived backend ticket for an HttpOnly LAN session cookie.
    server.on("/", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (request->hasParam("ticket")) {
            const String ticket = request->getParam("ticket")->value();
            if (!verifyTicket(ticket)) {
                request->send(403, "text/plain", "invalid or expired ticket");
                return;
            }
            auto *response = request->beginResponse(303);
            response->addHeader("Location", "/");
            response->addHeader("Set-Cookie", "iot_ticket=" + ticket + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=300");
            response->addHeader("Cache-Control", "no-store");
            response->addHeader("Referrer-Policy", "no-referrer");
            request->send(response);
            return;
        }
        if (!requireDeviceAuth(request)) return;
        request->send(LittleFS, "/dashboard.html", "text/html");
    });

    // Direct dashboard access uses the same Basic Auth / validated ticket cookie.
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
        bool is_ap_mode = (WiFi.getMode() == WIFI_AP) || (WiFi.getMode() == WIFI_AP_STA && WiFi.status() != WL_CONNECTED);
        String json = "{\"mqtt_connected\": false, \"is_ap_mode\": " + String(is_ap_mode ? "true" : "false") + "}"; 
        request->send(200, "application/json", json);
    });

    server.on("/api/ws-token", HTTP_GET, [](AsyncWebServerRequest *request) {
        uint32_t sessionDurationMs = 0;
        if (!requireDeviceAuth(request, &sessionDurationMs)) return;
        char buf[33];
        snprintf(buf, sizeof(buf), "%08x%08x%08x%08x",
                 (unsigned)esp_random(), (unsigned)esp_random(),
                 (unsigned)esp_random(), (unsigned)esp_random());
        s_wsToken = String(buf);
        s_wsTokenUntil = millis() + 30000UL;
        s_wsSessionUntil = millis() + sessionDurationMs;
        request->send(200, "application/json", "{\"token\":\"" + s_wsToken + "\"}");
    });
 
    server.on("/toggle-pump", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (!requireDeviceAuth(request)) return;
        String temp_state;
        bool has_param = request->hasParam("state");
        if (has_param) {
            temp_state = request->getParam("state")->value();
            temp_state.toUpperCase();
            if (temp_state != "ON" && temp_state != "OFF") {
                request->send(400, "text/plain", "invalid state");
                return;
            }
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
        String temp_mode;
        bool has_param = request->hasParam("mode");
        if (has_param) {
            temp_mode = request->getParam("mode")->value();
            temp_mode.toUpperCase();
            if (temp_mode != "AUTO" && temp_mode != "MANUAL") {
                request->send(400, "text/plain", "invalid mode");
                return;
            }
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
        JsonDocument src;
        Load_wifi_list(src);
        JsonDocument outDoc;
        JsonArray arr = outDoc.to<JsonArray>();
        if (src.is<JsonArray>()) {
            for (JsonObject item : src.as<JsonArray>()) {
                JsonObject o = arr.add<JsonObject>();
                o["ssid"] = item["ssid"];
            }
        }
        String out;
        serializeJson(outDoc, out);
        request->send(200, "application/json", out);
    });
 
    server.on("/api/server-url", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (!requireDeviceAuth(request)) return;
        JsonDocument doc;
        doc["url"] = g_sensorApiUrl;
        String out;
        serializeJson(doc, out);
        request->send(200, "application/json", out);
    });
 
    auto *serverUrlHandler = new AsyncCallbackJsonWebHandler("/api/server-url",
        [](AsyncWebServerRequest *request, JsonVariant &doc) {
            if (!requireDeviceAuth(request)) return;
            String url = doc["url"] | String("");
            url.trim();
            if (url.isEmpty() || url.length() > 256 ||
                !(url.startsWith("http://") || url.startsWith("https://"))) {
                request->send(400, "application/json", "{\"error\":\"invalid url\"}");
                return;
            }
            Save_server_url(url);
            request->send(200, "application/json", "{\"ok\":true}");
        });
    serverUrlHandler->setMethod(HTTP_POST);
    serverUrlHandler->setMaxContentLength(1024);
    server.addHandler(serverUrlHandler);

    auto *wifiSwitchHandler = new AsyncCallbackJsonWebHandler("/api/wifi-switch",
        [](AsyncWebServerRequest *request, JsonVariant &doc) {
            if (!requireDeviceAuth(request)) return;
            String ssid = doc["ssid"] | String("");
            String pass = doc["pass"] | String("");
            if (ssid.isEmpty() || ssid.length() > 32 || pass.length() > 64) {
                request->send(400, "application/json", "{\"error\":\"invalid wifi credentials\"}");
                return;
            }
            if (pass.isEmpty()) Lookup_wifi_pass(ssid, pass);
            if (xSemaphoreTake(g_wifiSwitchMutex, pdMS_TO_TICKS(20)) != pdTRUE) {
                request->send(503, "application/json", "{\"error\":\"wifi configuration busy\"}");
                return;
            }
            if (g_wifiSwitchFlag) {
                xSemaphoreGive(g_wifiSwitchMutex);
                request->send(409, "application/json", "{\"error\":\"wifi switch pending\"}");
                return;
            }
            g_wifiSwitchSSID = ssid;
            g_wifiSwitchPass = pass;
            g_wifiSwitchFlag = true;
            xSemaphoreGive(g_wifiSwitchMutex);
            request->send(200, "application/json", "{\"ok\":true}");
        });
    wifiSwitchHandler->setMethod(HTTP_POST);
    wifiSwitchHandler->setMaxContentLength(1024);
    server.addHandler(wifiSwitchHandler);

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
