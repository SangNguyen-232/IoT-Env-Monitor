#include "telemetry_client.h"
#include <Arduino.h>
#include <ArduinoJson.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include "shared_context.h"
#include "serial_log.h"
#include "sensor_format.h"
#include "web_server.h"
#include "device_config.h"
#include "fan.h"
#include "secrets.h"
#include <sys/time.h>

#define POST_QUEUE_MAX 6

static String postQueue[POST_QUEUE_MAX];
static int postQHead = 0;
static int postQCount = 0;
static unsigned long s_lastDBPostMs_sensor = 0;
static unsigned long s_lastDBPostMs_fan = 0;

static String formatTimestamp(time_t t)
{
    if (t == 0) return "null";
    struct tm timeinfo;
    gmtime_r(&t, &timeinfo);
    char buf[25];
    strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &timeinfo);
    return String(buf);
}

static const char* ruleStatusLabel(int lcdState)
{
    if (lcdState == 3) return "Critical";
    if (lcdState == 2) return "Warning";
    return "Normal";
}

static String sensorPostUrl()
{
    String u = g_sensorApiUrl;
    u.trim();
    if (u.isEmpty()) return u;
    if (u.endsWith("/sensor")) return u;
    if (u.endsWith("/")) return u + "sensor";
    return u + "/sensor";
}

static void enqueuePost(const String& payload)
{
    if (payload.isEmpty()) return;
    if (postQCount == POST_QUEUE_MAX)
    {
        postQHead = (postQHead + 1) % POST_QUEUE_MAX;
        postQCount--;
    }
    const int idx = (postQHead + postQCount) % POST_QUEUE_MAX;
    postQueue[idx] = payload;
    postQCount++;
}

static void popPost()
{
    if (postQCount == 0) return;
    postQueue[postQHead] = "";
    postQHead = (postQHead + 1) % POST_QUEUE_MAX;
    postQCount--;
}

static int postPayload(const String& payload)
{
    const String dbUrl = sensorPostUrl();
    if (dbUrl.isEmpty())
    {
        return -1;
    }

    HTTPClient http;
    int httpCode = -1;
    if (dbUrl.startsWith("https://"))
    {
        WiFiClientSecure client;
        client.setInsecure();
        if (!http.begin(client, dbUrl)) return -1;
        http.setTimeout(10000);
        http.addHeader("Content-Type", "application/json");
        http.addHeader("X-Device-Key", SENSOR_API_KEY);
        httpCode = http.POST(payload);
        http.end();
        return httpCode;
    }

    WiFiClient client;
    if (!http.begin(client, dbUrl)) return -1;
    http.setTimeout(10000);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Device-Key", SENSOR_API_KEY);
    httpCode = http.POST(payload);
    http.end();
    return httpCode;
}

static void flushPostQueue()
{
    if (postQCount == 0) return;
    if (WiFi.status() != WL_CONNECTED) return;
    if (sensorPostUrl().isEmpty()) return;

    int flushed = 0;
    while (postQCount > 0 && flushed < 2)
    {
        const int httpCode = postPayload(postQueue[postQHead]);
        serialLogLock();
        if (httpCode >= 200 && httpCode < 300)
        {
            Serial.printf("[DB] POST thành công -> %d (còn %d)\n", httpCode, postQCount - 1);
            serialLogUnlock();
            popPost();
        }
        else if (httpCode == 400 || httpCode == 413)
        {
            Serial.printf("[DB] POST bỏ payload không hợp lệ -> %d\n", httpCode);
            serialLogUnlock();
            popPost();
        }
        else
        {
            Serial.printf("[DB] POST thất bại -> %d, giữ buffer (%d)\n", httpCode, postQCount);
            serialLogUnlock();
            break;
        }
        flushed++;
    }
}

static String buildPayload(SharedContext *ctx, const char *triggerSource)
{
    float temperature = 0.0f;
    float humidity = 0.0f;
    int soilMoisture = 0;
    bool soilSampleValid = false;
    uint32_t soilSampledAtMs = 0;
    bool dhtSampleValid = false;
    uint32_t dhtSampledAtMs = 0;
    int lcdState = 1;
    float mlRollAcc = 0.0f;
    struct timeval tvReal = {0, 0};
    struct timeval tvUp   = {0, 0};
    String fanState;
    String modeState;

    if (ctx != NULL && xSemaphoreTake(ctx->mutexContext, pdMS_TO_TICKS(2000)) == pdTRUE)
    {
        temperature    = ctx->temperature;
        humidity       = ctx->humidity;
        soilMoisture   = ctx->soilMoisture;
        soilSampleValid = ctx->soilSampleValid;
        soilSampledAtMs = ctx->soilSampledAtMs;
        dhtSampleValid  = ctx->dhtSampleValid;
        dhtSampledAtMs  = ctx->dhtSampledAtMs;
        lcdState       = ctx->lcdState;
        mlRollAcc      = ctx->mlRollAcc;
        tvReal.tv_sec  = ctx->timestampReal;
        tvReal.tv_usec = ctx->timestampRealUs;
        xSemaphoreGive(ctx->mutexContext);
    } else {
        return String();
    }

    if (xSemaphoreTake(xMutexFanControl, pdMS_TO_TICKS(2000)) == pdTRUE)
    {
        fanState = global_fan_state;
        modeState = global_fan_mode;
        xSemaphoreGive(xMutexFanControl);
    } else {
        return String();
    }

    gettimeofday(&tvUp, nullptr);

    // Never enqueue an epoch-based timestamp while SNTP is not synchronized.
    if (tvUp.tv_sec < 1577836800) return String();
    const int64_t latencyUs = (((int64_t)tvUp.tv_sec * 1000000LL + tvUp.tv_usec)
                          - ((int64_t)tvReal.tv_sec * 1000000LL + tvReal.tv_usec));
    JsonDocument doc;
    char temperatureJson[24], humidityJson[24];
    if (tvReal.tv_sec >= 1577836800) doc["timestamp_real"] = formatTimestamp(tvReal.tv_sec);
    else doc["timestamp_real"] = nullptr;
    doc["timestamp_up"] = formatTimestamp(tvUp.tv_sec);
    const bool dhtValid = dht_sample_values_are_valid(temperature, humidity) &&
        dht_sample_is_fresh(dhtSampleValid, dhtSampledAtMs, millis());
    if (dhtValid) {
        // Preserve the sampled float value across JSON transport; round only in the UI.
        sensor_format_json_number(temperatureJson, sizeof(temperatureJson), temperature);
        sensor_format_json_number(humidityJson, sizeof(humidityJson), humidity);
        doc["temperature"] = serialized(temperatureJson);
        doc["humidity"] = serialized(humidityJson);
    } else {
        doc["temperature"] = nullptr;
        doc["humidity"] = nullptr;
    }
    if (soil_sample_is_fresh(soilSampleValid, soilSampledAtMs, millis()) &&
        soilMoisture >= 0 && soilMoisture <= 100) {
        doc["soil_moisture"] = soilMoisture;
    } else {
        doc["soil_moisture"] = nullptr;
    }
    doc["FAN_state"] = fanState;
    doc["MODE_state"] = modeState;
    if (dhtValid) doc["Message"] = ruleStatusLabel(lcdState);
    else doc["Message"] = nullptr;
    // Score is model/rule agreement (%), not a risk score or held-out accuracy.
    doc["Score"] = String(mlRollAcc, 2) + "%";
    doc["device_id"] = WiFi.macAddress();
    if (WiFi.status() == WL_CONNECTED) doc["lan_ip"] = WiFi.localIP().toString();
    else doc["lan_ip"] = nullptr;
    if (tvReal.tv_sec >= 1577836800 && latencyUs >= 0 && latencyUs <= INT32_MAX)
        doc["latency"] = static_cast<int32_t>(latencyUs);
    else doc["latency"] = nullptr;
    doc["trigger_source"] = triggerSource;
    String payload;
    serializeJson(doc, payload);
    return payload;
}

void task_database(void *pvParameters)
{
    SharedContext *ctx = static_cast<SharedContext *>(pvParameters);
    uint32_t waitMs = 5000U;

    while (1)
    {
        const bool gotEvent = xSemaphoreTake(ctx->semDBUpdate, pdMS_TO_TICKS(waitMs)) == pdTRUE;
        bool fanEvent = false;
        bool shouldPost = false;
        const uint32_t now = millis();
        waitMs = 5000U;
        if (xSemaphoreTake(ctx->mutexContext, pdMS_TO_TICKS(200)) == pdTRUE)
        {
            // A newer sensor snapshot must not overwrite a pending FAN event.
            fanEvent = g_fanEventPending;
            const uint32_t lastPost = fanEvent ? s_lastDBPostMs_fan : s_lastDBPostMs_sensor;
            shouldPost = (gotEvent || fanEvent) && static_cast<uint32_t>(now - lastPost) >= 200U;
            if (fanEvent) {
                if (shouldPost) g_fanEventPending = false;
                else waitMs = 200U;
            }
            xSemaphoreGive(ctx->mutexContext);
        }

        if (shouldPost)
        {
            const String payload = buildPayload(ctx, fanEvent ? "fan" : "sensor");
            if (!payload.isEmpty()) {
                enqueuePost(payload);
                if (fanEvent) s_lastDBPostMs_fan = millis();
                else s_lastDBPostMs_sensor = millis();
            } else if (fanEvent) {
                // Retain the event if a complete snapshot/time was unavailable.
                if (xSemaphoreTake(ctx->mutexContext, portMAX_DELAY) == pdTRUE) {
                    g_fanEventPending = true;
                    xSemaphoreGive(ctx->mutexContext);
                }
                waitMs = 200U;
            }
        }

        flushPostQueue();
    }
}
