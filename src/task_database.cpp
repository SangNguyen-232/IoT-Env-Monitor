#include "task_database.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include "serial_log.h"
#include "task_webserver.h"
#include "task_check_info.h"
#include "pump.h"
#include "secrets.h"
#include <sys/time.h>

#define POST_QUEUE_MAX 6

static String postQueue[POST_QUEUE_MAX];
static int postQHead = 0;
static int postQCount = 0;

static String formatTimestamp(time_t t)
{
    if (t == 0) return "null";
    struct tm timeinfo;
    localtime_r(&t, &timeinfo);
    char buf[20];
    strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", &timeinfo);
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
    int lcdState = 1;
    float mlRollAcc = 0.0f;
    struct timeval tvReal = {0, 0};
    struct timeval tvUp   = {0, 0};
    String pumpState;
    String modeState;

    if (ctx != NULL && xSemaphoreTake(ctx->mutexContext, pdMS_TO_TICKS(2000)) == pdTRUE)
    {
        temperature    = ctx->temperature;
        humidity       = ctx->humidity;
        soilMoisture   = ctx->soilMoisture;
        lcdState       = ctx->lcdState;
        mlRollAcc      = ctx->mlRollAcc;
        tvReal.tv_sec  = ctx->timestampReal;
        tvReal.tv_usec = ctx->timestampRealUs;
        xSemaphoreGive(ctx->mutexContext);
    }

    if (xSemaphoreTake(xMutexPumpControl, pdMS_TO_TICKS(2000)) == pdTRUE)
    {
        pumpState = global_pump_state;
        modeState = global_pump_mode;
        xSemaphoreGive(xMutexPumpControl);
    }

    gettimeofday(&tvUp, nullptr);

    int64_t latencyUs = (((int64_t)tvUp.tv_sec  * 1000000LL + tvUp.tv_usec)
                    - ((int64_t)tvReal.tv_sec * 1000000LL + tvReal.tv_usec));

    String scoreStr;
    if (mlRollAcc >= 100.0f)
    {
        scoreStr = "100";
    }
    else
    {
        scoreStr = String(mlRollAcc, 2);
    }

    String lanIp = "";
    if (WiFi.status() == WL_CONNECTED)
    {
        lanIp = WiFi.localIP().toString();
    }

    String payload = "{";
    payload += "\"timestamp_real\":\"" + formatTimestamp(tvReal.tv_sec) + "\",";
    payload += "\"timestamp_up\":\"" + formatTimestamp(tvUp.tv_sec) + "\",";
    payload += "\"temperature\":\"" + String(temperature, 2) + "\\u00B0C\",";
    payload += "\"humidity\":\"" + String(humidity, 2) + "%\",";
    char soilBuf[8];
    snprintf(soilBuf, sizeof(soilBuf), "%02d", soilMoisture);
    payload += "\"soil_moisture\":\"" + String(soilBuf) + "%\",";
    payload += "\"PUMP_state\":\"" + pumpState + "\",";
    payload += "\"MODE_state\":\"" + modeState + "\",";
    payload += "\"Message\":\"" + String(ruleStatusLabel(lcdState)) + "\",";
    payload += "\"Score\":\"" + scoreStr + "%\",";
    payload += "\"device_id\":\"" + WiFi.macAddress() + "\",";
    payload += "\"lan_ip\":\"" + lanIp + "\",";
    payload += "\"latency\":" + String((long long)latencyUs) + ",";
    payload += "\"trigger_source\":\"" + String(triggerSource) + "\"";
    payload += "}";
    return payload;
}

void task_database(void *pvParameters)
{
    SharedContext *ctx = static_cast<SharedContext *>(pvParameters);

    while (1)
    {
        const bool gotEvent = xSemaphoreTake(ctx->semDBUpdate, pdMS_TO_TICKS(5000)) == pdTRUE;

        if (gotEvent)
        {
            char triggerSource[8] = "sensor";
            if (ctx != NULL && xSemaphoreTake(ctx->mutexContext, pdMS_TO_TICKS(200)) == pdTRUE)
            {
                strncpy(triggerSource, ctx->dbTriggerSource, sizeof(triggerSource) - 1);
                triggerSource[sizeof(triggerSource) - 1] = '\0';
                xSemaphoreGive(ctx->mutexContext);
            }

            unsigned long minGap      = 200UL;
            unsigned long lastPostMs  = (strcmp(triggerSource, "pump") == 0)
                                        ? g_lastDBPostMs_pump
                                        : g_lastDBPostMs_sensor;
            if (millis() - lastPostMs >= minGap)
            {
                if (strcmp(triggerSource, "pump") == 0)
                {
                    g_pumpEventPending = false;
                }

                const bool skipSensorForPump =
                    strcmp(triggerSource, "sensor") == 0 &&
                    (g_pumpEventPending || millis() - g_lastDBPostMs_pump < 200UL);

                if (!skipSensorForPump)
                {
                    enqueuePost(buildPayload(ctx, triggerSource));
                    if (strcmp(triggerSource, "pump") == 0)
                        g_lastDBPostMs_pump   = millis();
                    else
                        g_lastDBPostMs_sensor = millis();
                }
            }
        }

        flushPostQueue();
    }
}
