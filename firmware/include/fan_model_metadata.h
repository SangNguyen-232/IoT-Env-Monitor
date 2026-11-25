#pragma once

#include <stdint.h>

// Generated INT8 sliding-window trend model metadata.
namespace fan_model {
constexpr const char *MODEL_VERSION = "fan-trend-int8-v2-8abd0b91c744";
constexpr const char *MODEL_SHA256 = "8abd0b91c74416bfaf274f6531e3ff7388200be4fc1ca1621dff048aa3f182cc";
constexpr const char *PROFILE = "trend-or-30-28-75-70-30s-v2";
constexpr uint8_t FEATURE_COUNT = 8U;
constexpr uint8_t WINDOW_SIZE = 7U;
constexpr uint8_t MIN_WINDOW_SAMPLES = 7U;
constexpr uint32_t MAX_STEP_GAP_MS = 8000U;
constexpr uint8_t HORIZON_SECONDS = 30U;
constexpr float FEATURE_CLIP = 4.0f;
constexpr float T_MIN = 5.0f;
constexpr float T_MAX = 50.0f;
constexpr float H_MIN = 20.0f;
constexpr float H_MAX = 100.0f;
constexpr float REF_T_ON = 30.0f;
constexpr float REF_T_OFF = 28.0f;
constexpr float REF_H_ON = 75.0f;
constexpr float REF_H_OFF = 70.0f;
} // namespace fan_model
