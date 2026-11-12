#pragma once

#include <cmath>
#include <stdint.h>
#include "input_safety.h"
#include "fan_model_metadata.h"

enum class AiStatus : uint8_t { Loading, Ready, SensorInvalid, OutOfDomain, InferenceError, ModelError, Stale };
enum class FanAction : int8_t { Unknown = -1, Off = 0, Hold = 1, On = 2 };

struct MlResult {
    AiStatus status = AiStatus::Loading;
    uint32_t sampleSeq = 0;
    uint32_t sampledAtMs = 0;
    FanAction predicted = FanAction::Unknown;
    FanAction rule = FanAction::Unknown;
    float probabilities[3] = {0, 0, 0};
    float inferenceMs = 0;
    uint32_t evaluated = 0;
    uint32_t agreed = 0;
};

inline const char *ai_status_name(AiStatus status)
{
    switch (status) {
        case AiStatus::Ready: return "ready";
        case AiStatus::SensorInvalid: return "sensor_invalid";
        case AiStatus::OutOfDomain: return "out_of_domain";
        case AiStatus::InferenceError: return "inference_error";
        case AiStatus::ModelError: return "model_error";
        case AiStatus::Stale: return "stale";
        default: return "loading";
    }
}

inline const char *fan_action_name(FanAction action)
{
    switch (action) {
        case FanAction::Off: return "OFF";
        case FanAction::Hold: return "HOLD";
        case FanAction::On: return "ON";
        default: return nullptr;
    }
}

inline bool fan_model_in_domain(float t, float h)
{
    return std::isfinite(t) && std::isfinite(h) && t >= fan_model::T_MIN && t <= fan_model::T_MAX
        && h >= fan_model::H_MIN && h <= fan_model::H_MAX;
}

inline FanAction fan_model_teacher(float t, float h)
{
    if (t >= fan_model::T_ON || h >= fan_model::H_ON) return FanAction::On;
    if (t <= fan_model::T_OFF && h <= fan_model::H_OFF) return FanAction::Off;
    return FanAction::Hold;
}

inline bool ml_probabilities_valid(const MlResult &result)
{
    float sum = 0;
    for (float p : result.probabilities) {
        if (!std::isfinite(p) || p < 0 || p > 1) return false;
        sum += p;
    }
    const int label = static_cast<int>(result.predicted);
    if (label < 0 || label > 2 || std::fabs(sum - 1.0f) > 0.001f) return false;
    for (float p : result.probabilities) if (p > result.probabilities[label]) return false;
    return true;
}

inline AiStatus ml_effective_status(const MlResult &result, uint32_t sampleSeq,
                                    bool valid, uint32_t sampledAtMs, uint32_t now)
{
    // Model initialization errors remain visible even before the first sample.
    if (result.status == AiStatus::ModelError) return AiStatus::ModelError;
    if (sampleSeq == 0) return AiStatus::Loading;
    if (!valid) return AiStatus::SensorInvalid;
    if (!dht_sample_is_fresh(valid, sampledAtMs, now)) return AiStatus::Stale;
    if (result.sampleSeq != sampleSeq || result.sampledAtMs != sampledAtMs) return AiStatus::Stale;
    return result.status;
}
