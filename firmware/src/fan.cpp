#include "fan.h"
#include <atomic>
#include "shared_context.h"
#include "web_server.h"
#include "serial_log.h"

static constexpr uint8_t FAN_PIN = 10;

FanMode fan_requested_mode = FanMode::Auto;
bool fan_manual_state = false;
const char *fan_last_reason = "config_required";
uint32_t fan_decision_sample_seq = 0;
uint32_t fan_decided_uptime_ms = 0;
FanConfig fan_config;
FanConfig fan_decision_config;
SemaphoreHandle_t xMutexFanControl = xSemaphoreCreateMutex();

static std::atomic<bool> appliedCommand{false};

bool fan_commanded_on()
{
    return appliedCommand.load(std::memory_order_relaxed);
}

static void writeRelay(bool on)
{
    digitalWrite(FAN_PIN, on ? HIGH : LOW);
    appliedCommand.store(on, std::memory_order_relaxed);
}

void fan_init()
{
    digitalWrite(FAN_PIN, LOW);
    pinMode(FAN_PIN, OUTPUT);
    writeRelay(false);
}

void task_fan(void *pvParameters)
{
    SharedContext *ctx = static_cast<SharedContext *>(pvParameters);
    FanPolicyState policy;
    bool last_reported_state = false;
    String last_reported_mode = "AUTO";
    const char *last_reported_reason = "";
    bool database_event_pending = false;

    while (1) {
        FanPolicyInput input;
        FanPolicyResult result{false, false, "control_unavailable"};
        String current_mode;
        bool mode_available = false;
        if (xMutexFanControl != nullptr
                && xSemaphoreTake(xMutexFanControl, pdMS_TO_TICKS(200)) == pdTRUE) {
            // Keep the sampled inputs current through the GPIO commit. The sensor
            // can publish the next (possibly invalid) reading as soon as this finishes.
            const bool lockedSensor = ctx && ctx->mutexContext
                && xSemaphoreTake(ctx->mutexContext, pdMS_TO_TICKS(100)) == pdTRUE;
            if (lockedSensor) {
                input.temperature = ctx->temperature;
                input.humidity = ctx->humidity;
                input.dhtValid = ctx->dhtSampleValid;
                input.dhtSampledAtMs = ctx->dhtSampledAtMs;
                input.sampleSeq = ctx->sampleSeq;
                input.ml = ctx->ml;
            }
            input.controlAvailable = true;
            input.mode = fan_requested_mode;
            input.manualState = fan_manual_state;
            input.now = millis();
            result = fan_policy_step(policy, input, fan_config);

            // Apply the output and publish its actual state atomically with the
            // control snapshot. HTTP handlers only change the requested state.
            writeRelay(result.on);
            if (lockedSensor) xSemaphoreGive(ctx->mutexContext);
            global_fan_state = result.on ? "ON" : "OFF";
            global_fan_mode = fan_mode_name(input.mode);
            fan_last_reason = result.reason;
            fan_decision_sample_seq = input.sampleSeq;
            fan_decided_uptime_ms = input.now;
            fan_decision_config = fan_config;
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
            writeRelay(false);
        }

        if (result.manualTimedOut) {
            serialLogLock();
            Serial.println("[FAN] MANUAL runtime exceeded 5 minutes -> forcing fan OFF");
            serialLogUnlock();
        }

        if (result.on != last_reported_state
                || (mode_available && current_mode != last_reported_mode)
                || strcmp(result.reason, last_reported_reason) != 0) {
            last_reported_state = result.on;
            if (mode_available) last_reported_mode = current_mode;
            last_reported_reason = result.reason;

            serialLogLock();
            Serial.printf("[FAN] sample=%lu decided_ms=%lu mode=%s state=%s fan_reason=%s\n",
                          static_cast<unsigned long>(input.sampleSeq), static_cast<unsigned long>(input.now),
                          mode_available ? current_mode.c_str() : "--", result.on ? "ON" : "OFF", result.reason);
            serialLogUnlock();

            String wsPayload = "{\"fan_state\":\"" + String(result.on ? "ON" : "OFF") + "\"";
            if (mode_available) wsPayload += ",\"fan_mode\":\"" + current_mode + "\"";
            wsPayload += ",\"fan_reason\":\"" + String(result.reason) + "\"";
            wsPayload += ",\"fan_decision_sample_seq\":" + String(input.sampleSeq);
            wsPayload += ",\"fan_decided_uptime_ms\":" + String(input.now) + "}";
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

        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(100));
    }
}
