#pragma once

#include <cstdio>
#include <cstring>
#include "input_safety.h"

// Nine significant digits round-trip a float32. ArduinoJson may compact a
// double back to float32 and serialize fewer digits, so callers use this text
// as serialized(...) numeric JSON rather than a quoted display string.
inline void sensor_format_json_number(char *out, size_t capacity, float value)
{
    if (std::isfinite(value)) std::snprintf(out, capacity, "%.9g", static_cast<double>(value));
    else std::snprintf(out, capacity, "null");
}

// Round the actual sensor float in double precision, matching browser Number
// arithmetic after its numeric JSON representation has preserved that value.
inline int sensor_display_tenths(float value)
{
    return static_cast<int>(std::round(static_cast<double>(value) * 10.0));
}

inline void sensor_format_temperature(char *out, size_t capacity, float value)
{
    if (!dht_sample_values_are_valid(value, 0.0f)) {
        std::snprintf(out, capacity, "--.-");
        return;
    }
    const int tenths = sensor_display_tenths(value);
    const int magnitude = tenths < 0 ? -tenths : tenths;
    std::snprintf(out, capacity, "%s%d.%d", tenths < 0 ? "-" : "",
                  magnitude / 10, magnitude % 10);
}

inline void sensor_format_humidity(char *out, size_t capacity, float value)
{
    if (!dht_sample_values_are_valid(0.0f, value)) {
        std::snprintf(out, capacity, "--");
        return;
    }
    const int tenths = sensor_display_tenths(value);
    if (tenths == 0) std::snprintf(out, capacity, "00");
    else if (tenths % 10 == 0) std::snprintf(out, capacity, "%d", tenths / 10);
    else std::snprintf(out, capacity, "%d.%d", tenths / 10, tenths % 10);
}

inline void sensor_format_lcd_air_row(char (&out)[17], float temperature,
                                      float humidity, bool valid)
{
    if (!valid || !dht_sample_values_are_valid(temperature, humidity)) {
        std::snprintf(out, sizeof(out), "T:--.-C H:--.-%% ");
        return;
    }
    // Valid ranges need at most "-40.0" and "99.9", respectively.
    char temperature_text[6], humidity_text[5];
    sensor_format_temperature(temperature_text, sizeof(temperature_text), temperature);
    sensor_format_humidity(humidity_text, sizeof(humidity_text), humidity);
    const int length = std::snprintf(out, sizeof(out), "T:%s%cC H:%s%%",
                                     temperature_text, static_cast<char>(223), humidity_text);
    if (length > 16) {
        std::snprintf(out, sizeof(out), "T:%s%cCH:%s%%",
                      temperature_text, static_cast<char>(223), humidity_text);
    }
    size_t used = std::strlen(out);
    while (used < 16) out[used++] = ' ';
    out[16] = '\0';
}
