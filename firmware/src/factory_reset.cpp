#include "factory_reset.h"
#include <Arduino.h>
#include "device_config.h"

#define BOOT_PIN 0

void Task_Toggle_BOOT(void *pvParameters)
{
    (void)pvParameters;
    unsigned long buttonPressStartTime = 0;
    pinMode(BOOT_PIN, INPUT_PULLUP);
    while (true) {
        if (digitalRead(BOOT_PIN) == LOW) {
            if (buttonPressStartTime == 0) {
                buttonPressStartTime = millis();
            } else if (millis() - buttonPressStartTime > 2000) {
                Delete_info_File();
            }
        } else {
            buttonPressStartTime = 0;
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}
