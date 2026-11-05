#pragma once

#include <algorithm>

static inline int risk_led_state_from_temperature(float t)
{
    if (t < 10.0f || t > 30.0f)
        return 3; // Critical
    if (t < 15.0f || t > 25.0f)
        return 2; // Warning
    return 1;     // Normal
}

static inline int risk_neo_state_from_humidity(float h)
{
    if (h < 50.0f || h > 80.0f)
        return 3; // Critical
    if (h < 60.0f || h > 70.0f)
        return 2; // Warning
    return 1;     // Normal
}

static inline float calc_penalty_temp(float t)
{
    if (t >= 15.0f && t <= 25.0f) {
        return 0.0f;
    }
    if (t >= 10.0f && t < 15.0f) {
        return 5.0f * ((15.0f - t) / 5.0f);
    }
    if (t > 25.0f && t <= 30.0f) {
        return 5.0f * ((t - 25.0f) / 5.0f);
    }
    if (t < 10.0f) {
        return 5.0f + 5.0f * std::min((10.0f - t) / 10.0f, 1.0f);
    }
    return 5.0f + 5.0f * std::min((t - 30.0f) / 10.0f, 1.0f);
}

static inline float calc_penalty_humi(float h)
{
    if (h >= 60.0f && h <= 70.0f) {
        return 0.0f;
    }
    if (h >= 50.0f && h < 60.0f) {
        return 5.0f * ((60.0f - h) / 10.0f);
    }
    if (h > 70.0f && h <= 80.0f) {
        return 5.0f * ((h - 70.0f) / 10.0f);
    }
    if (h < 50.0f) {
        return 5.0f + 5.0f * std::min((50.0f - h) / 20.0f, 1.0f);
    }
    return 5.0f + 5.0f * std::min((h - 80.0f) / 15.0f, 1.0f);
}

static inline float calc_penalty_soil(float s)
{
    if (s >= 30.0f && s <= 40.0f) {
        return 0.0f;
    }
    if (s >= 25.0f && s < 30.0f) {
        return 5.0f * ((30.0f - s) / 5.0f);
    }
    if (s > 40.0f && s <= 45.0f) {
        return 5.0f * ((s - 40.0f) / 5.0f);
    }
    if (s < 25.0f) {
        return 5.0f + 5.0f * std::min((25.0f - s) / 20.0f, 1.0f);
    }
    return 5.0f + 5.0f * std::min((s - 45.0f) / 15.0f, 1.0f);
}

static inline int risk_pure_mathematical_label(float temperature, float humidity, float soil_moisture)
{
    float r = 0.35f * calc_penalty_temp(temperature) +
              0.20f * calc_penalty_humi(humidity) +
              0.45f * calc_penalty_soil(soil_moisture);

    if (r <= 3.0f) return 1; // Normal
    if (r <= 6.5f) return 2; // Warning
    return 3;                // Critical
}

static inline int risk_final_safety_label(float temperature, float humidity, float soil_moisture)
{
    if (temperature >= 40.0f || humidity >= 90.0f || soil_moisture < 15.0f || soil_moisture > 60.0f) {
        return 3;
    }
    return risk_pure_mathematical_label(temperature, humidity, soil_moisture);
}
