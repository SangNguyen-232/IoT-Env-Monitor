#include "environment_monitor.h"
#include "risk_policy.h"
#include "web_server.h"
#include "shared_context.h"
#include <Arduino.h>
#include <WiFi.h>
#include <Wire.h>
#include <DHT20.h>
#include <LiquidCrystal_I2C.h>
#include <sys/time.h>

#define SOIL_PIN 2

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
    lcd.setCursor(1, 0);
    lcd.print("IOT ASSIGNMENT");

    vTaskDelay(pdMS_TO_TICKS(5000));
    lcd.clear();

    while (1) {
        const int dht_status = dht20.read();
        float temperature = dht20.getTemperature();
        float humidity = dht20.getHumidity();

        const int raw_soil = analogRead(SOIL_PIN);
        const int soil_moisture = map(raw_soil, 0, 4095, 0, 100);

        const bool dht_ok = dht_status == DHT20_OK && isfinite(temperature) && isfinite(humidity)
                            && humidity >= 0.0f && humidity <= 100.0f;
        if (!dht_ok) {
            temperature = humidity = -1.0f;
        }

        int capturedLcdState = 1;
        if (ctx != nullptr) {
            xSemaphoreTake(ctx->mutexContext, portMAX_DELAY);

            ctx->temperature = temperature;
            ctx->humidity = humidity;
            ctx->soilMoisture = soil_moisture;
            // ADC rails may indicate a disconnected/shorted sensor. AUTO fails closed.
            ctx->soilSampleValid = raw_soil > 0 && raw_soil < 4095;
            ctx->soilSampledAtMs = millis();

            if (WiFi.status() == WL_CONNECTED) {
                struct timeval tv;
                gettimeofday(&tv, nullptr);
                ctx->timestampReal   = tv.tv_sec;
                ctx->timestampRealUs = tv.tv_usec;
            } else {
                ctx->timestampReal   = 0;
                ctx->timestampRealUs = 0;
            }

            strncpy(ctx->dbTriggerSource, "sensor", sizeof(ctx->dbTriggerSource) - 1);
            ctx->dbTriggerSource[sizeof(ctx->dbTriggerSource) - 1] = '\0';

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

                ctx->lcdState = risk_final_safety_label(temperature, humidity, static_cast<float>(soil_moisture));
            }
            capturedLcdState = ctx->lcdState;

            xSemaphoreGive(ctx->mutexContext);
            xSemaphoreGive(ctx->semDBUpdate);
        }

        lcd.setCursor(0, 0);
        if (!dht_ok) {
            lcd.print("T:--.-C H:--.-% ");
        } else {
            char row0[17];
            if (humidity >= 99.95f) {
                snprintf(row0, sizeof(row0), "T:%.1f%cC H:100%%", temperature, static_cast<char>(223));
            } else {
                snprintf(row0, sizeof(row0), "T:%.1f%cC H:%.1f%%", temperature, static_cast<char>(223), humidity);
            }
            size_t len = strlen(row0);
            while (len < 16) row0[len++] = ' ';
            row0[16] = '\0';
            lcd.print(row0);
        }

        char row1[17];
        snprintf(row1, sizeof(row1), "SM:%02d%%  %-8s", soil_moisture, statusText(capturedLcdState));
        lcd.setCursor(0, 1);
        lcd.print(row1);

        String wsPayload = "{";
        if (dht_ok) {
            wsPayload += "\"temperature\":" + String(temperature, 2) +
                         ",\"humidity\":" + String(humidity, 2) + ",";
        }
        wsPayload += "\"soil_moisture\":" + String(soil_moisture) +
                     ",\"lcd_state\":" + String(capturedLcdState) + "}";
        Webserver_sendata(wsPayload);

        vTaskDelay(pdMS_TO_TICKS(5000));
    }
}
