#include "domain/input_safety.h"
#include "domain/risk_policy.h"
#include <assert.h>
#include <stdint.h>

int main()
{
    // Startup, absent samples, stale samples, and the millis() rollover boundary.
    assert(!soil_sample_is_fresh(false, 0, 0));
    assert(soil_sample_is_fresh(true, 1000, 16000));
    assert(!soil_sample_is_fresh(true, 1000, 16001));
    assert(soil_sample_is_fresh(true, UINT32_MAX - 4999, 10000));
    assert(!soil_sample_is_fresh(true, UINT32_MAX - 4999, 10001));

    assert(websocket_frame_is_complete(true, 0, 12, 12));
    assert(websocket_frame_is_complete(true, 0, 1024, 1024));
    assert(!websocket_frame_is_complete(true, 0, 1025, 1025));
    assert(!websocket_frame_is_complete(false, 0, 12, 12));
    assert(!websocket_frame_is_complete(true, 3, 12, 9));
    assert(!websocket_frame_is_complete(true, 0, 12, 10));
    assert(!websocket_frame_is_complete(true, 0, 0, 0));

    assert(risk_led_state_from_temperature(10) == 2);
    assert(risk_led_state_from_temperature(15) == 1);
    assert(risk_led_state_from_temperature(30) == 2);
    assert(risk_led_state_from_temperature(30.01f) == 3);
    assert(risk_neo_state_from_humidity(60) == 1);
    assert(risk_neo_state_from_humidity(80) == 2);
    assert(risk_soil_state_from_moisture(25) == 2);
    assert(risk_soil_state_from_moisture(30) == 1);
    assert(risk_pure_mathematical_label(20, 65, 35) == 1);
    assert(risk_final_safety_label(20, 65, 14) == 3);
    assert(risk_final_safety_label(40, 65, 35) == 3);
    assert(risk_final_safety_label(20, 90, 35) == 3);
    return 0;
}
