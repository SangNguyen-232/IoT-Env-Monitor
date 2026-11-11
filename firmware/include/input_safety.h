#pragma once

#include <stddef.h>
#include <stdint.h>
#include <cmath>

// DHT20 measurement limits; validity is separate from the numeric values so a
// failed read cannot masquerade as a legitimate negative temperature sample.
inline bool dht_sample_values_are_valid(float temperature, float humidity)
{
    return std::isfinite(temperature) && temperature >= -40.0f && temperature <= 80.0f
        && std::isfinite(humidity) && humidity >= 0.0f && humidity <= 100.0f;
}

// Unsigned subtraction remains valid when the millisecond counter wraps.
inline bool dht_sample_is_fresh(bool valid, uint32_t sampledAt, uint32_t now)
{
    return valid && static_cast<uint32_t>(now - sampledAt) <= 15000U;
}

inline bool soil_sample_is_fresh(bool valid, uint32_t sampledAt, uint32_t now)
{
    return valid && static_cast<uint32_t>(now - sampledAt) <= 15000U;
}

inline bool websocket_frame_is_complete(bool final, uint64_t index, uint64_t total, size_t length)
{
    return final && index == 0 && total == length && length > 0 && length <= 1024;
}
