#pragma once

#include <cmath>
#include <stdint.h>
#include "fan_model_metadata.h"

struct TemporalMetrics {
    float tempSlopeCPerMin = 0.0f;
    float humiSlopePctPerMin = 0.0f;
    float residualJitter = 0.0f;
    float scaledFeatures[fan_model::FEATURE_COUNT] = {};
};

class TemporalWindow {
public:
    void reset() { count_ = head_ = 0; }
    uint8_t size() const { return count_; }

    void push(float temperature, float humidity, uint32_t sampledAtMs, uint32_t sampleSeq)
    {
        if (count_) {
            const uint32_t dt = sampledAtMs - at(count_ - 1).sampledAtMs;
            const uint32_t next = lastSeq_ == UINT32_MAX ? 1 : lastSeq_ + 1;
            if (sampleSeq != next || dt == 0 || dt > fan_model::MAX_STEP_GAP_MS) reset();
        }
        lastSeq_ = sampleSeq;
        const uint8_t write = (head_ + count_) % fan_model::WINDOW_SIZE;
        samples_[write] = {temperature, humidity, sampledAtMs};
        if (count_ == fan_model::WINDOW_SIZE) head_ = (head_ + 1) % fan_model::WINDOW_SIZE;
        else ++count_;
    }

    bool extract(bool fanWasOn, TemporalMetrics &out) const
    {
        if (count_ < fan_model::MIN_WINDOW_SAMPLES) return false;
        const uint32_t start = at(0).sampledAtMs;
        double meanSeconds = 0, meanT = 0, meanH = 0;
        for (uint8_t i = 0; i < count_; ++i) {
            const Sample &s = at(i);
            meanSeconds += (s.sampledAtMs - start) / 1000.0;
            meanT += s.temperature;
            meanH += s.humidity;
        }
        meanSeconds /= count_;
        meanT /= count_;
        meanH /= count_;
        double timeVariance = 0, covarianceT = 0, covarianceH = 0;
        for (uint8_t i = 0; i < count_; ++i) {
            const Sample &s = at(i);
            const double dt = (s.sampledAtMs - start) / 1000.0 - meanSeconds;
            timeVariance += dt * dt;
            covarianceT += dt * (s.temperature - meanT);
            covarianceH += dt * (s.humidity - meanH);
        }
        const double slopeT = covarianceT / timeVariance;
        const double slopeH = covarianceH / timeVariance;
        const double spanT = fan_model::REF_T_ON - fan_model::REF_T_OFF;
        const double spanH = fan_model::REF_H_ON - fan_model::REF_H_OFF;
        double squaredResiduals = 0;
        for (uint8_t i = 0; i < count_; ++i) {
            const Sample &s = at(i);
            const double dt = (s.sampledAtMs - start) / 1000.0 - meanSeconds;
            const double rt = (s.temperature - meanT - dt * slopeT) / spanT;
            const double rh = (s.humidity - meanH - dt * slopeH) / spanH;
            squaredResiduals += rt * rt + rh * rh;
        }
        const Sample &now = at(count_ - 1);
        const Sample &prev = at(count_ - 2);
        const double lastSeconds = (now.sampledAtMs - prev.sampledAtMs) / 1000.0;
        out.tempSlopeCPerMin = slopeT * 60;
        out.humiSlopePctPerMin = slopeH * 60;
        out.residualJitter = std::sqrt(squaredResiduals / count_);
        out.scaledFeatures[0] = scale((now.temperature - fan_model::REF_T_OFF) / spanT);
        out.scaledFeatures[1] = scale((now.humidity - fan_model::REF_H_OFF) / spanH);
        out.scaledFeatures[2] = scale(slopeT * 60 / spanT);
        out.scaledFeatures[3] = scale(slopeH * 60 / spanH);
        out.scaledFeatures[4] = scale((now.temperature - prev.temperature) * 60.0 / (lastSeconds * spanT));
        out.scaledFeatures[5] = scale((now.humidity - prev.humidity) * 60.0 / (lastSeconds * spanH));
        out.scaledFeatures[6] = scale(out.residualJitter);
        out.scaledFeatures[7] = fanWasOn ? 1.0f : 0.0f;
        return true;
    }

private:
    struct Sample { float temperature, humidity; uint32_t sampledAtMs; };
    static_assert(fan_model::FEATURE_COUNT == 8 && fan_model::MIN_WINDOW_SAMPLES >= 2
                  && fan_model::MIN_WINDOW_SAMPLES <= fan_model::WINDOW_SIZE, "unexpected feature contract");
    const Sample &at(uint8_t index) const { return samples_[(head_ + index) % fan_model::WINDOW_SIZE]; }
    static float scale(double v) {
        const double scaled = v / fan_model::FEATURE_CLIP;
        return scaled < -1 ? -1 : (scaled > 1 ? 1 : static_cast<float>(scaled));
    }

    Sample samples_[fan_model::WINDOW_SIZE] = {};
    uint32_t lastSeq_ = 0;
    uint8_t head_ = 0, count_ = 0;
};
