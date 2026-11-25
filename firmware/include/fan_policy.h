#pragma once

#include <cmath>
#include <stdint.h>
#include "input_safety.h"
#include "ml_result.h"

// Configured from the dashboard. No AUTO thresholds are assumed at first boot.
struct FanConfig {
    bool configured = false;
    float temperatureOn = 0.0f;
    float temperatureOff = 0.0f;
    float humidityOn = 0.0f;
    float humidityOff = 0.0f;
    bool requireBoth = false;
};

inline bool fan_config_is_valid(const FanConfig &config)
{
    return dht_sample_values_are_valid(config.temperatureOn, config.humidityOn)
        && dht_sample_values_are_valid(config.temperatureOff, config.humidityOff)
        && config.temperatureOff < config.temperatureOn
        && config.humidityOff < config.humidityOn;
}

inline bool fan_configs_equal(const FanConfig &left, const FanConfig &right)
{
    return left.configured == right.configured
        && left.temperatureOn == right.temperatureOn
        && left.temperatureOff == right.temperatureOff
        && left.humidityOn == right.humidityOn
        && left.humidityOff == right.humidityOff
        && left.requireBoth == right.requireBoth;
}

inline bool fan_config_matches_model_profile(const FanConfig &config)
{
    return config.configured && !config.requireBoth
        && config.temperatureOn == fan_model::REF_T_ON && config.temperatureOff == fan_model::REF_T_OFF
        && config.humidityOn == fan_model::REF_H_ON && config.humidityOff == fan_model::REF_H_OFF;
}

enum class FanMode : uint8_t { Auto, Shadow, Ai, Manual };

inline const char *fan_mode_name(FanMode mode)
{
    switch (mode) {
        case FanMode::Shadow: return "SHADOW";
        case FanMode::Ai: return "AI";
        case FanMode::Manual: return "MANUAL";
        default: return "AUTO";
    }
}

static constexpr uint32_t FAN_MANUAL_MAX_RUN_MS = 300000U;
static constexpr uint32_t FAN_MIN_ON_MS = 10000U;
static constexpr uint32_t FAN_MIN_OFF_MS = 10000U;
static constexpr float FAN_AI_MIN_SCORE = 0.80f;

struct FanPolicyInput {
    bool controlAvailable = false;
    FanMode mode = FanMode::Auto;
    bool manualState = false;
    float temperature = 0.0f;
    float humidity = 0.0f;
    bool dhtValid = false;
    uint32_t sampleSeq = 0;
    uint32_t dhtSampledAtMs = 0;
    uint32_t now = 0;
    MlResult ml;
};

struct FanPolicyState {
    bool autoOn = false;
    FanConfig lastAutoConfig;
    FanMode lastMode = FanMode::Auto;
    bool initialized = false;
    bool lastOutput = false;
    uint32_t changedAtMs = 0;
    bool wasManual = false;
    bool manualRunActive = false;
    uint32_t manualStartedAtMs = 0;
    bool manualTimeoutLatched = false;
};

struct FanPolicyResult {
    bool on;
    bool manualTimedOut;
    const char *reason;
};

inline void fan_policy_acknowledge_manual_off(FanPolicyState &state)
{
    state.manualRunActive = false;
    state.manualStartedAtMs = 0;
    state.manualTimeoutLatched = false;
}

inline const char *ai_fallback_reason(AiStatus status)
{
    switch (status) {
        case AiStatus::WarmingUp: return "ai_fallback_warming_up";
        case AiStatus::Ready: return "ai_fallback_low_score";
        case AiStatus::SensorInvalid: return "ai_fallback_sensor_invalid";
        case AiStatus::OutOfDomain: return "ai_fallback_out_of_domain";
        case AiStatus::InferenceError: return "ai_fallback_inference_error";
        case AiStatus::ModelError: return "ai_fallback_model_error";
        case AiStatus::Stale: return "ai_fallback_stale";
        default: return "ai_fallback_loading";
    }
}

inline FanPolicyResult fan_policy_step(FanPolicyState &state,
                                      const FanPolicyInput &input,
                                      const FanConfig &config)
{
    if (!state.initialized) {
        state.initialized = true;
        state.changedAtMs = input.now;
    }
    const auto finish = [&](bool on, bool timeout, const char *reason) -> FanPolicyResult {
        if (on != state.lastOutput) state.changedAtMs = input.now;
        state.lastOutput = on;
        return {on, timeout, reason};
    };
    if (!input.controlAvailable) {
        state.autoOn = false;
        // Keep a running manual deadline across lock failures.
        return finish(false, false, "control_unavailable");
    }
    if (input.mode == FanMode::Manual) {
        state.lastMode = FanMode::Manual;
        state.autoOn = false;
        if (!state.wasManual) fan_policy_acknowledge_manual_off(state);
        state.wasManual = true;
        if (!input.manualState) {
            fan_policy_acknowledge_manual_off(state);
            return finish(false, false, "manual_off");
        }
        if (state.manualTimeoutLatched) return finish(false, false, "manual_timeout");
        if (!state.manualRunActive) {
            state.manualStartedAtMs = input.now;
            state.manualRunActive = true;
        }
        if (static_cast<uint32_t>(input.now - state.manualStartedAtMs) >= FAN_MANUAL_MAX_RUN_MS) {
            state.manualRunActive = false;
            state.manualTimeoutLatched = true;
            return finish(false, true, "manual_timeout");
        }
        return finish(true, false, "manual_on");
    }
    state.wasManual = false;
    fan_policy_acknowledge_manual_off(state);
    const bool changed = input.mode != state.lastMode || !fan_configs_equal(config, state.lastAutoConfig);
    state.lastMode = input.mode;
    state.lastAutoConfig = config;
    // Start the OFF dwell even if a simultaneous sensor fault takes priority below.
    if (changed) state.changedAtMs = input.now;
    if (!config.configured || !fan_config_is_valid(config)) {
        state.autoOn = false;
        return finish(false, false, "config_required");
    }
    if (input.sampleSeq == 0 || !dht_sample_is_fresh(input.dhtValid, input.dhtSampledAtMs, input.now)
            || !dht_sample_values_are_valid(input.temperature, input.humidity)) {
        state.autoOn = false;
        // Safety OFF and explicit mode changes bypass dwell; MANUAL is separate.
        return finish(false, false, "sensor_invalid");
    }
    if (changed) {
        state.autoOn = false;
        return finish(false, false, "mode_changed");
    }
    bool desired = state.autoOn;
    if (desired) {
        const bool tLow = input.temperature <= config.temperatureOff;
        const bool hLow = input.humidity <= config.humidityOff;
        if (config.requireBoth ? (tLow || hLow) : (tLow && hLow)) desired = false;
    } else {
        const bool tHigh = input.temperature >= config.temperatureOn;
        const bool hHigh = input.humidity >= config.humidityOn;
        desired = config.requireBoth ? (tHigh && hHigh) : (tHigh || hHigh);
    }
    const char *reason = desired ? "rule_on" : "rule_off";

    if (input.mode == FanMode::Ai) {
        if (!fan_config_matches_model_profile(config)) {
            reason = "ai_fallback_profile_mismatch";
        } else {
            AiStatus status = ml_effective_status(input.ml, input.sampleSeq, input.dhtValid,
                                                  input.dhtSampledAtMs, input.now);
            if (!fan_model_in_domain(input.temperature, input.humidity)) status = AiStatus::OutOfDomain;
            if (status == AiStatus::Ready && !ml_probabilities_valid(input.ml)) status = AiStatus::InferenceError;
            if (status != AiStatus::Ready
                    || input.ml.probabilities[static_cast<int>(input.ml.predicted)] < FAN_AI_MIN_SCORE) {
                reason = ai_fallback_reason(status);
            } else {
                const FanAction rule = fan_reference_action(input.temperature, input.humidity);
                const FanAction proposal = input.ml.predicted;
                if (rule == FanAction::On) {
                    desired = true;
                    reason = proposal == FanAction::On ? "ai_on" : "ai_guard_threshold_on";
                } else if (rule == FanAction::Off) {
                    desired = false;
                    reason = proposal == FanAction::Off ? "ai_off" : "ai_guard_threshold_off";
                } else if (proposal == FanAction::On) {
                    // A confident forecast can start ventilation inside the hysteresis band.
                    desired = true;
                    reason = "ai_proactive_on";
                } else {
                    // Once running, only crossing BOTH lower limits can stop the relay.
                    desired = state.autoOn;
                    reason = proposal == FanAction::Hold ? "ai_hold"
                        : state.autoOn ? "ai_guard_hysteresis" : "ai_off";
                }
            }
        }
    }
    const uint32_t dwell = state.autoOn ? FAN_MIN_ON_MS : FAN_MIN_OFF_MS;
    if (desired != state.autoOn && static_cast<uint32_t>(input.now - state.changedAtMs) < dwell) {
        reason = state.autoOn ? "min_on_time" : "min_off_time";
        desired = state.autoOn;
    }
    state.autoOn = desired;
    return finish(desired, false, reason);
}
