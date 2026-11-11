#include "environment_monitor.h"
#include "risk_policy.h"
#include "web_server.h"
#include "shared_context.h"
#include "input_safety.h"
#include "sensor_format.h"
#include <Arduino.h>
#include <ArduinoJson.h>
#include <WiFi.h>
#include <Wire.h>
#include <DHT20.h>
#include <LiquidCrystal_I2C.h>
#include <sys/time.h>

static constexpr uint8_t SOIL_PIN = 2;
static DHT20 dht20;
static LiquidCrystal_I2C lcd(0x27, 16, 2);

static const char *statusText(int state)
{
    if (state == 3) return "Critical";
    if (state == 2) return "Warning";
    return "Normal";
}

void temp_humi_monitor(void *pvParameters)
{
    SharedContext *ctx = static_cast<SharedContext *>(pvParameters);

    Wire.begin(11, 12);
    dht20.begin();

    lcd.begin();
    lcd.backlight();
    lcd.clear();
    // Startup greeting runs once when this task starts, never in the sample loop.
    lcd.setCursor(1, 0);
    lcd.print("IOT ASSIGNMENT");
    vTaskDelay(pdMS_TO_TICKS(5000));
    lcd.clear();

    while (1) {
        const int dht_status = dht20.read();
        const uint32_t dht_sampled_at = millis();
        float temperature = dht20.getTemperature();
        float humidity = dht20.getHumidity();

        // Soil is observed independently; it never enters FAN or air-risk logic.
        const int raw_soil = analogRead(SOIL_PIN);
        const uint32_t soil_sampled_at = millis();
        const int soil_moisture = map(raw_soil, 0, 4095, 0, 100);
        const bool soil_ok = raw_soil > 0 && raw_soil < 4095;

        const bool dht_ok = dht_status == DHT20_OK
                           && dht_sample_values_are_valid(temperature, humidity);
        if (!dht_ok) {
            temperature = humidity = -1.0f;
        }

        int capturedLcdState = 1;
        if (ctx != nullptr) {
            xSemaphoreTake(ctx->mutexContext, portMAX_DELAY);

            ctx->temperature = temperature;
            ctx->humidity = humidity;
            ctx->dhtSampleValid = dht_ok;
            ctx->dhtSampledAtMs = dht_sampled_at;
            ctx->soilMoisture = soil_moisture;
            ctx->soilSampleValid = soil_ok;
            ctx->soilSampledAtMs = soil_sampled_at;

            if (WiFi.status() == WL_CONNECTED) {
                struct timeval tv;
                gettimeofday(&tv, nullptr);
                ctx->timestampReal   = tv.tv_sec;
                ctx->timestampRealUs = tv.tv_usec;
            } else {
                ctx->timestampReal   = 0;
                ctx->timestampRealUs = 0;
            }

            if (dht_ok) {
                const int newLedState = risk_led_state_from_temperature(temperature);
                if (newLedState != ctx->ledState) {
                    ctx->ledState = newLedState;
                    xSemaphoreGive(ctx->semLEDUpdate);
                }

                const int newNeoState = risk_neo_state_from_humidity(humidity);
                if (newNeoState != ctx->neoState) {
                    ctx->neoState = newNeoState;
                    xSemaphoreGive(ctx->semNeoUpdate);
                }

                ctx->lcdState = risk_final_safety_label(temperature, humidity);
            }
            capturedLcdState = ctx->lcdState;

            xSemaphoreGive(ctx->mutexContext);
            xSemaphoreGive(ctx->semDBUpdate);
        }

        lcd.setCursor(0, 0);
        char row0[17];
        sensor_format_lcd_air_row(row0, temperature, humidity, dht_ok);
        lcd.print(row0);

        char row1[17];
        // The status at the right describes air risk, independent of soil.
        if (soil_ok) {
            char soil_display[4];
            snprintf(soil_display, sizeof(soil_display), "%02d", soil_moisture);
            snprintf(row1, sizeof(row1), "SM:%3s%% %-8s", soil_display,
                     dht_ok ? statusText(capturedLcdState) : "No data");
        } else {
            snprintf(row1, sizeof(row1), "SM: --%% %-8s",
                     dht_ok ? statusText(capturedLcdState) : "No data");
        }
        lcd.setCursor(0, 1);
        lcd.print(row1);

        JsonDocument wsPayload;
        char temperature_json[24], humidity_json[24];
        if (dht_ok) {
            // Preserve the numeric readings; each display applies its own format.
            sensor_format_json_number(temperature_json, sizeof(temperature_json), temperature);
            sensor_format_json_number(humidity_json, sizeof(humidity_json), humidity);
            wsPayload["temperature"] = serialized(temperature_json);
            wsPayload["humidity"] = serialized(humidity_json);
        }
        if (soil_ok) wsPayload["soil_moisture"] = soil_moisture;
        else wsPayload["soil_moisture"] = nullptr;
        if (dht_ok) wsPayload["lcd_state"] = capturedLcdState;
        else wsPayload["lcd_state"] = nullptr;
        String wsJson;
        serializeJson(wsPayload, wsJson);
        Webserver_sendata(wsJson);

        vTaskDelay(pdMS_TO_TICKS(5000));
    }
}
