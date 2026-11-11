#pragma once

#include <cmath>
#include <stdint.h>
#include "input_safety.h"

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

static constexpr uint32_t FAN_MANUAL_MAX_RUN_MS = 300000U;

struct FanPolicyInput {
    bool controlAvailable = false;
    bool manualControl = false;
    bool manualState = false;
    float temperature = 0.0f;
    float humidity = 0.0f;
    bool dhtValid = false;
    uint32_t dhtSampledAtMs = 0;
    uint32_t now = 0;
};

struct FanPolicyState {
    bool autoOn = false;
    FanConfig lastAutoConfig;
    bool wasManual = false;
    bool manualRunActive = false;
    uint32_t manualStartedAtMs = 0;
    bool manualTimeoutLatched = false;
};

struct FanPolicyResult {
    bool on;
    bool manualTimedOut;
};

// Call only when an OFF request has been observed or committed under the control
// mutex. A subsequent explicit ON can then start a new five-minute run.
inline void fan_policy_acknowledge_manual_off(FanPolicyState &state)
{
    state.manualRunActive = false;
    state.manualStartedAtMs = 0;
    state.manualTimeoutLatched = false;
}

inline FanPolicyResult fan_policy_step(FanPolicyState &state,
                                      const FanPolicyInput &input,
                                      const FanConfig &config)
{
    if (!input.controlAvailable) {
        state.autoOn = false;
        // Preserve an existing manual deadline across a temporary lock failure.
        return {false, false};
    }

    if (input.manualControl) {
        // Manual output must never seed the AUTO hysteresis state.
        state.autoOn = false;
        if (!state.wasManual) fan_policy_acknowledge_manual_off(state);
        state.wasManual = true;

        if (!input.manualState) {
            fan_policy_acknowledge_manual_off(state);
            return {false, false};
        }
        if (state.manualTimeoutLatched) return {false, false};
        if (!state.manualRunActive) {
            state.manualStartedAtMs = input.now;
            state.manualRunActive = true;
        }
        if (static_cast<uint32_t>(input.now - state.manualStartedAtMs) >= FAN_MANUAL_MAX_RUN_MS) {
            state.manualRunActive = false;
            state.manualTimeoutLatched = true;
            return {false, true};
        }
        return {true, false};
    }

    state.wasManual = false;
    fan_policy_acknowledge_manual_off(state);
    if (!fan_configs_equal(config, state.lastAutoConfig)) {
        // Evaluate a newly saved policy from OFF instead of carrying demand
        // from the old policy into the new policy's hysteresis band.
        state.autoOn = false;
        state.lastAutoConfig = config;
    }
    if (!config.configured || !fan_config_is_valid(config)
            || !dht_sample_is_fresh(input.dhtValid, input.dhtSampledAtMs, input.now)
            || !dht_sample_values_are_valid(input.temperature, input.humidity)) {
        state.autoOn = false;
        return {false, false};
    }

    if (state.autoOn) {
        const bool temperatureLow = input.temperature <= config.temperatureOff;
        const bool humidityLow = input.humidity <= config.humidityOff;
        const bool stop = config.requireBoth ? (temperatureLow || humidityLow)
                                            : (temperatureLow && humidityLow);
        if (stop) state.autoOn = false;
    } else {
        const bool temperatureHigh = input.temperature >= config.temperatureOn;
        const bool humidityHigh = input.humidity >= config.humidityOn;
        state.autoOn = config.requireBoth ? (temperatureHigh && humidityHigh)
                                         : (temperatureHigh || humidityHigh);
    }
    return {state.autoOn, false};
}
