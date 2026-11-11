#include "fan.h"
#include "shared_context.h"
#include "web_server.h"
#include "serial_log.h"

static constexpr uint8_t FAN_PIN = 10;

bool fan_manual_control = false;
bool fan_manual_state = false;
FanConfig fan_config;
SemaphoreHandle_t xMutexFanControl = xSemaphoreCreateMutex();

void fan_init()
{
    digitalWrite(FAN_PIN, LOW);
    pinMode(FAN_PIN, OUTPUT);
    digitalWrite(FAN_PIN, LOW);
}

void task_fan(void *pvParameters)
{
    SharedContext *ctx = static_cast<SharedContext *>(pvParameters);
    FanPolicyState policy;
    bool last_reported_state = false;
    String last_reported_mode = "AUTO";
    bool database_event_pending = false;

    while (1) {
        FanPolicyInput input;
        if (ctx != nullptr && ctx->mutexContext != nullptr
                && xSemaphoreTake(ctx->mutexContext, pdMS_TO_TICKS(200)) == pdTRUE) {
            input.temperature = ctx->temperature;
            input.humidity = ctx->humidity;
            input.dhtValid = ctx->dhtSampleValid;
            input.dhtSampledAtMs = ctx->dhtSampledAtMs;
            xSemaphoreGive(ctx->mutexContext);
        }

        FanPolicyResult result{false, false};
        String current_mode;
        bool mode_available = false;
        if (xMutexFanControl != nullptr
                && xSemaphoreTake(xMutexFanControl, pdMS_TO_TICKS(200)) == pdTRUE) {
            input.controlAvailable = true;
            input.manualControl = fan_manual_control;
            input.manualState = fan_manual_state;
            input.now = millis();
            result = fan_policy_step(policy, input, fan_config);

            // Apply the output and publish its actual state atomically with the
            // control snapshot. HTTP handlers only change the requested state.
            digitalWrite(FAN_PIN, result.on ? HIGH : LOW);
            global_fan_state = result.on ? "ON" : "OFF";
            global_fan_mode = input.manualControl ? "MANUAL" : "AUTO";
            current_mode = global_fan_mode;
            mode_available = true;
            if (result.manualTimedOut) {
                fan_manual_state = false;
                fan_policy_acknowledge_manual_off(policy);
            }
            xSemaphoreGive(xMutexFanControl);
        } else {
            input.now = millis();
            result = fan_policy_step(policy, input, FanConfig{});
            // Physical shutoff never depends on obtaining the reporting mutex.
            // The actual shared state is resynchronized on the next valid lock.
            digitalWrite(FAN_PIN, LOW);
        }

        if (result.manualTimedOut) {
            serialLogLock();
            Serial.println("[FAN] MANUAL chay qua 5 phut -> tu tat quat");
            serialLogUnlock();
        }

        if (result.on != last_reported_state
                || (mode_available && current_mode != last_reported_mode)) {
            last_reported_state = result.on;
            if (mode_available) last_reported_mode = current_mode;

            String wsPayload = "{\"fan_state\":\"" + String(result.on ? "ON" : "OFF") + "\"";
            if (mode_available) wsPayload += ",\"fan_mode\":\"" + current_mode + "\"";
            wsPayload += "}";
            Webserver_sendata(wsPayload);
            database_event_pending = true;
        }

        // Retain transitions when the context mutex is busy. The telemetry task
        // consumes this flag under the same mutex, even if a sensor event follows.
        if (database_event_pending && ctx != nullptr && ctx->mutexContext != nullptr
                && xSemaphoreTake(ctx->mutexContext, pdMS_TO_TICKS(200)) == pdTRUE) {
            g_fanEventPending = true;
            xSemaphoreGive(ctx->mutexContext);
            if (ctx->semDBUpdate != nullptr) xSemaphoreGive(ctx->semDBUpdate);
            database_event_pending = false;
        }

        vTaskDelay(pdMS_TO_TICKS(100));
    }
}
