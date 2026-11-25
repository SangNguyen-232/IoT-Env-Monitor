#pragma once

#include "fan_inference.h"
#include "temporal_window.h"

class FanPredictor {
public:
    bool begin()
    {
        ready_ = inference_.begin();
        return ready_;
    }
    size_t arenaUsedBytes() const { return inference_.arenaUsedBytes(); }

    // Called once for every acquisition, including failures. All observations
    // share the DHT sample identity and the actuator command captured at that time.
    MlResult evaluate(float t, float h, bool valid, bool fanWasOn, uint32_t sampledAtMs,
                      uint32_t sampleSeq, uint32_t now, unsigned long (*microsClock)() = nullptr)
    {
        MlResult result;
        result.sampleSeq = sampleSeq;
        result.sampledAtMs = sampledAtMs;
        result.fanWasOn = fanWasOn;
        if (!valid || !dht_sample_values_are_valid(t, h)) {
            result.status = AiStatus::SensorInvalid;
            window_.reset();
        } else if (!dht_sample_is_fresh(valid, sampledAtMs, now)) {
            result.status = AiStatus::Stale;
            window_.reset();
        } else if (!ready_) {
            result.status = AiStatus::ModelError;
        } else if (!fan_model_in_domain(t, h)) {
            result.status = AiStatus::OutOfDomain;
            window_.reset();
        } else {
            window_.push(t, h, sampledAtMs, sampleSeq);
            result.windowSamples = window_.size();
            TemporalMetrics metrics;
            if (!window_.extract(fanWasOn, metrics)) {
                result.status = AiStatus::WarmingUp;
            } else {
                const uint32_t start = microsClock ? microsClock() : 0;
                const bool ok = inference_.invoke(metrics.scaledFeatures, result);
                if (microsClock) result.inferenceMs = static_cast<uint32_t>(microsClock() - start) / 1000.0f;
                result.status = ok ? AiStatus::Ready : AiStatus::InferenceError;
                if (ok) {
                    result.rule = fan_reference_action(t, h);
                    result.tempSlopeCPerMin = metrics.tempSlopeCPerMin;
                    result.humiSlopePctPerMin = metrics.humiSlopePctPerMin;
                    result.residualJitter = metrics.residualJitter;
                    if (evaluated_ == UINT32_MAX) { evaluated_ = 0; agreed_ = 0; }
                    ++evaluated_;
                    if (result.predicted == result.rule) ++agreed_;
                }
            }
        }
        result.evaluated = evaluated_;
        result.agreed = agreed_;
        return result;
    }

private:
    FanInference inference_;
    TemporalWindow window_;
    uint32_t evaluated_ = 0;
    uint32_t agreed_ = 0;
    bool ready_ = false;
};
