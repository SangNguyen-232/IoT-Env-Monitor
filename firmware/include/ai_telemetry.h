#pragma once

#include <ArduinoJson.h>
#include "shared_context.h"

// Serialize a copied, internally consistent sensor/model snapshot.
inline void ai_result_to_json(JsonObject out, const MlResult &result, uint32_t sampleSeq,
                              bool valid, uint32_t sampledAtMs, uint32_t now)
{
    AiStatus status = ml_effective_status(result, sampleSeq, valid, sampledAtMs, now);
    if (status == AiStatus::Ready && !ml_probabilities_valid(result)) status = AiStatus::InferenceError;
    out["model_version"] = fan_model::MODEL_VERSION;
    out["status"] = ai_status_name(status);
    out["sample_seq"] = result.sampleSeq;
    out["sampled_uptime_ms"] = result.sampledAtMs;
    out["window_capacity"] = fan_model::WINDOW_SIZE;
    out["window_samples"] = (status == AiStatus::Stale || status == AiStatus::SensorInvalid) ? 0 : result.windowSamples;
    out["inference_ms"] = result.inferenceMs;
    out["evaluated_samples"] = result.evaluated;
    if (result.evaluated) out["agreement_pct"] = 100.0 * result.agreed / result.evaluated;
    else out["agreement_pct"] = nullptr;
    if (status == AiStatus::Ready) {
        out["predicted_class"] = fan_action_name(result.predicted);
        out["rule_class"] = fan_action_name(result.rule);
        out["temp_slope_c_min"] = result.tempSlopeCPerMin;
        out["humi_slope_pct_min"] = result.humiSlopePctPerMin;
        out["residual_jitter"] = result.residualJitter;
        out["fan_on_at_sample"] = result.fanWasOn;
        JsonArray probabilities = out["probabilities"].to<JsonArray>();
        for (float p : result.probabilities) probabilities.add(p);
    } else {
        out["predicted_class"] = nullptr;
        out["rule_class"] = nullptr;
        out["temp_slope_c_min"] = nullptr;
        out["humi_slope_pct_min"] = nullptr;
        out["residual_jitter"] = nullptr;
        out["fan_on_at_sample"] = nullptr;
        out["probabilities"] = nullptr;
    }
}

inline bool ai_snapshot_to_json(SharedContext *ctx, JsonDocument &doc)
{
    if (!ctx || !ctx->mutexContext || xSemaphoreTake(ctx->mutexContext, pdMS_TO_TICKS(200)) != pdTRUE) return false;
    doc["boot_id"] = ctx->bootId;
    doc["sample_seq"] = ctx->sampleSeq;
    doc["sampled_uptime_ms"] = ctx->dhtSampledAtMs;
    const uint32_t now = millis();
    if (dht_sample_is_fresh(ctx->dhtSampleValid, ctx->dhtSampledAtMs, now) &&
        dht_sample_values_are_valid(ctx->temperature, ctx->humidity)) {
        doc["temperature"] = ctx->temperature;
        doc["humidity"] = ctx->humidity;
    } else {
        doc["temperature"] = nullptr;
        doc["humidity"] = nullptr;
    }
    ai_result_to_json(doc["ai"].to<JsonObject>(), ctx->ml, ctx->sampleSeq,
                      ctx->dhtSampleValid, ctx->dhtSampledAtMs, now);
    xSemaphoreGive(ctx->mutexContext);
    return true;
}
