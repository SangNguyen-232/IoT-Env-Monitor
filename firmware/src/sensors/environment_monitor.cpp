#include "sensors/environment_monitor.h"
#include "domain/risk_policy.h"
#include "diagnostics/serial_log.h"
#include "web/web_server.h"
#include "app/shared_context.h"
#include <Arduino.h>
#include <Wire.h>
#include <DHT20.h>
#include <LiquidCrystal_I2C.h>
#include <sys/time.h>

#define SOIL_PIN 2

DHT20 dht20;
LiquidCrystal_I2C lcd(0x27, 16, 2);

static const char* statusText(int state) {
    if (state == 3) return "Critical";
    if (state == 2) return "Warning";
    return "Normal";
}

void temp_humi_monitor(void *pvParameters) {

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

        int raw_soil = analogRead(SOIL_PIN);
        int soil_moisture = map(raw_soil, 0, 4095, 0, 100);

        const bool dht_ok = dht_status == DHT20_OK && isfinite(temperature) && isfinite(humidity)
                            && humidity >= 0.0f && humidity <= 100.0f;
        if (!dht_ok) {
            temperature = humidity = -1;
        }

        if (pvParameters != NULL) {
            SharedContext* ctx = (SharedContext*)pvParameters;
            xSemaphoreTake(ctx->mutexContext, portMAX_DELAY);

            ctx->temperature = temperature;
            ctx->humidity = humidity;
            ctx->soilMoisture = soil_moisture;
            ctx->soilRaw = raw_soil;
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

                const int newLcdState = risk_final_safety_label(temperature, humidity, (float)soil_moisture);
                if (newLcdState != ctx->lcdState) {
                    ctx->lcdState = newLcdState;
                }
            }

            xSemaphoreGive(ctx->mutexContext);
            xSemaphoreGive(ctx->semDBUpdate);
        }

        lcd.setCursor(0, 0);
        if (!dht_ok) {
            lcd.print("T:--.-C H:--.-% ");
        } else {
            lcd.print("T:");
            lcd.print(temperature, 1);
            lcd.print((char)223);
            lcd.print("C H:");
            if (humidity >= 99.95) {
                lcd.print("100% ");
            } else {
                lcd.print(humidity, 1);
                lcd.print("%");
            }
        }

        lcd.setCursor(0, 1);
        char buffer[8];
        snprintf(buffer, sizeof(buffer), "SM:%02d%%   ", soil_moisture);
        lcd.print(buffer);

        int capturedLcdState = 1;
        if (pvParameters != NULL) {
            SharedContext* ctx = (SharedContext*)pvParameters;
            xSemaphoreTake(ctx->mutexContext, portMAX_DELAY);
            capturedLcdState = ctx->lcdState;
            xSemaphoreGive(ctx->mutexContext);
            lcd.setCursor(8, 1);
            lcd.print("        ");
            lcd.setCursor(8, 1);
            lcd.print(statusText(capturedLcdState));
        }

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
