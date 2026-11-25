#include "tinyml.h"
#include "ai_telemetry.h"
#include "serial_log.h"
#include "web_server.h"
#include <TensorFlowLite_ESP32.h>
#include "fan_predictor.h"

void tiny_ml_task(void *pvParameters)
{
    SharedContext *ctx = static_cast<SharedContext *>(pvParameters);
    if (!ctx || !ctx->mutexContext) { vTaskDelete(nullptr); return; }

    static FanPredictor predictor;
    if (!predictor.begin()) {
        xSemaphoreTake(ctx->mutexContext, portMAX_DELAY);
        ctx->ml.status = AiStatus::ModelError;
        xSemaphoreGive(ctx->mutexContext);
        Serial.println("[AI] INT8 model initialization failed; deterministic fallback active");
    } else {
        serialLogLock();
        Serial.printf("[AI] model=%s arena_used=%uB window_storage=%uB\n", fan_model::MODEL_VERSION,
                      static_cast<unsigned>(predictor.arenaUsedBytes()), static_cast<unsigned>(sizeof(TemporalWindow)));
        serialLogUnlock();
    }
    uint32_t lastSeq = 0, lastSampledAt = 0;

    while (true) {
        xSemaphoreTake(ctx->mutexContext, portMAX_DELAY);
        const uint32_t seq = ctx->sampleSeq;
        const uint32_t sampledAt = ctx->dhtSampledAtMs;
        const float t = ctx->temperature;
        const float h = ctx->humidity;
        const bool valid = ctx->dhtSampleValid;
        const bool fanWasOn = ctx->fanOnAtSample;
        xSemaphoreGive(ctx->mutexContext);
        if (!seq || (seq == lastSeq && sampledAt == lastSampledAt)) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }
        lastSeq = seq;
        lastSampledAt = sampledAt;
        const MlResult result = predictor.evaluate(t, h, valid, fanWasOn, sampledAt, seq, millis(), micros);
        xSemaphoreTake(ctx->mutexContext, portMAX_DELAY);
        const bool current = ctx->sampleSeq == seq && ctx->dhtSampledAtMs == sampledAt;
        if (current) {
            ctx->ml = result;
            g_aiEventPending = true;
        }
        xSemaphoreGive(ctx->mutexContext);
        if (current) {
            if (ctx->fanTask) xTaskNotifyGive(ctx->fanTask);
            xSemaphoreGive(ctx->semDBUpdate);
            JsonDocument doc;
            if (ai_snapshot_to_json(ctx, doc)) {
                String json;
                serializeJson(doc, json);
                Webserver_sendata(json);
            }
            serialLogLock();
            Serial.printf("[AI] sample=%lu sampled_ms=%lu status=%s win=%u/%u fan_input=%s",
                          static_cast<unsigned long>(seq), static_cast<unsigned long>(sampledAt),
                          ai_status_name(result.status), static_cast<unsigned>(result.windowSamples),
                          static_cast<unsigned>(fan_model::WINDOW_SIZE), fanWasOn ? "ON" : "OFF");
            if (valid) Serial.printf(" T=%.2f RH=%.2f", t, h);
            if (result.status == AiStatus::Ready) {
                Serial.printf(" dT=%+.2fC/min dH=%+.2f%%/min jitter=%.3f reference=%s proposal=%s p=[%.3f,%.3f,%.3f] latency=%.3fms",
                              result.tempSlopeCPerMin, result.humiSlopePctPerMin, result.residualJitter,
                              fan_action_name(result.rule), fan_action_name(result.predicted),
                              result.probabilities[0], result.probabilities[1], result.probabilities[2], result.inferenceMs);
            }
            Serial.println();
            serialLogUnlock();
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}
