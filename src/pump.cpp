#include "pump.h"
#include "global.h"
#include "task_webserver.h"

#define PUMP_PIN 10
// Align AUTO on-threshold with soil Critical (< 25). Previous value 5 never
// watered during Critical 5–25 and had no hysteresis / max runtime.
#define PUMP_SOIL_ON 25
#define PUMP_SOIL_OFF 32
#define PUMP_MAX_RUN_MS 60000UL
#define PUMP_COOLDOWN_MS 120000UL

bool pump_manual_control = false;
bool pump_manual_state = false;
SemaphoreHandle_t xMutexPumpControl = xSemaphoreCreateMutex();

void task_pump(void *pvParameters)
{
    SharedContext* ctx = (SharedContext*)pvParameters;

    pinMode(PUMP_PIN, OUTPUT);
    digitalWrite(PUMP_PIN, LOW);

    bool last_reported_state = false;
    bool auto_pump_on = false;
    unsigned long pump_on_since = 0;
    unsigned long cooldown_until = 0;

    while (1) {
        int current_soil = 0;
        if (ctx != NULL) {
            if (xSemaphoreTake(ctx->mutexContext, pdMS_TO_TICKS(200)) == pdTRUE) {
                current_soil = ctx->soilMoisture;
                xSemaphoreGive(ctx->mutexContext);
            }
        }

        bool current_manual_control = false;
        bool current_manual_state = false;
        if (xSemaphoreTake(xMutexPumpControl, pdMS_TO_TICKS(200)) == pdTRUE) {
            current_manual_control = pump_manual_control;
            current_manual_state = pump_manual_state;
            xSemaphoreGive(xMutexPumpControl);
        }

        bool new_state;
        const unsigned long now = millis();
        if (current_manual_control) {
            new_state = current_manual_state;
            auto_pump_on = new_state;
            if (new_state && pump_on_since == 0) {
                pump_on_since = now;
            }
            if (!new_state) {
                pump_on_since = 0;
            }
        } else {
            if (auto_pump_on && (now - pump_on_since) >= PUMP_MAX_RUN_MS) {
                auto_pump_on = false;
                pump_on_since = 0;
                cooldown_until = now + PUMP_COOLDOWN_MS;
            } else if ((long)(now - cooldown_until) < 0) {
                auto_pump_on = false;
            } else if (auto_pump_on) {
                if (current_soil >= PUMP_SOIL_OFF) {
                    auto_pump_on = false;
                    pump_on_since = 0;
                }
            } else if (current_soil < PUMP_SOIL_ON) {
                auto_pump_on = true;
                pump_on_since = now;
            }
            new_state = auto_pump_on;
        }

        digitalWrite(PUMP_PIN, new_state ? HIGH : LOW);

        if (new_state != last_reported_state) {
            last_reported_state = new_state;

            String modeStr;
            if (xSemaphoreTake(xMutexPumpControl, pdMS_TO_TICKS(200)) == pdTRUE) {
                global_pump_state = new_state ? "ON" : "OFF";
                modeStr = global_pump_mode;
                xSemaphoreGive(xMutexPumpControl);
            }

            String wsPayload = "{\"pump_state\":\"" + String(new_state ? "ON" : "OFF") +
                                "\",\"pump_mode\":\"" + modeStr + "\"}";
            Webserver_sendata(wsPayload);

            if (ctx != NULL) {
                if (xSemaphoreTake(ctx->mutexContext, pdMS_TO_TICKS(200)) == pdTRUE) {
                    strncpy(ctx->dbTriggerSource, "pump", sizeof(ctx->dbTriggerSource) - 1);
                    ctx->dbTriggerSource[sizeof(ctx->dbTriggerSource) - 1] = '\0';
                    xSemaphoreGive(ctx->mutexContext);
                }
                g_pumpEventPending = true;
                xSemaphoreGive(ctx->semDBUpdate);
            }
        }

        vTaskDelay(100 / portTICK_PERIOD_MS);
    }
}
