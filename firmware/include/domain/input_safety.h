#pragma once

#include <stddef.h>
#include <stdint.h>

// Unsigned subtraction remains valid when the millisecond counter wraps.
inline bool soil_sample_is_fresh(bool valid, uint32_t sampledAt, uint32_t now)
{
    return valid && static_cast<uint32_t>(now - sampledAt) <= 15000U;
}

inline bool websocket_frame_is_complete(bool final, uint64_t index, uint64_t total, size_t length)
{
    return final && index == 0 && total == length && length > 0 && length <= 1024;
}
