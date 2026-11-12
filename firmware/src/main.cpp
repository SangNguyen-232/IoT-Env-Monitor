#include "shared_context.h"
#include "serial_log.h"
#include "esp_log.h"
#include "esp_system.h"

#include "status_led.h"
#include "rgb_led.h"
#include "environment_monitor.h"
#include "tinyml.h"
#include "telemetry_client.h"

#include "device_config.h"
#include "factory_reset.h"
#include "wifi_manager.h"
#include "web_server.h"
#include "fan.h"
#include "fan_config.h"

static const char *resetReasonText(esp_reset_reason_t reason)
{
    switch (reason) {
        case ESP_RST_POWERON: return "POWERON";
        case ESP_RST_EXT: return "EXTERNAL";
        case ESP_RST_SW: return "SOFTWARE";
        case ESP_RST_PANIC: return "PANIC";
        case ESP_RST_INT_WDT: return "INTERRUPT_WATCHDOG";
        case ESP_RST_TASK_WDT: return "TASK_WATCHDOG";
        case ESP_RST_WDT: return "WATCHDOG";
        case ESP_RST_DEEPSLEEP: return "DEEP_SLEEP";
        case ESP_RST_BROWNOUT: return "BROWNOUT";
        case ESP_RST_SDIO: return "SDIO";
        default: return "UNKNOWN";
    }
}

void setup()
{
    fan_init();
    Serial.begin(115200);
    serialLogInit();
    const esp_reset_reason_t resetReason = esp_reset_reason();
    Serial.printf("[BOOT] reset_reason=%s (%u), build=%s %s\n",
                  resetReasonText(resetReason), static_cast<unsigned>(resetReason),
                  __DATE__, __TIME__);
    esp_log_level_set("*", ESP_LOG_WARN);
    esp_log_level_set("vfs_api", ESP_LOG_NONE);
    check_info_File(false);
    fan_load_config();

    SharedContext *ctx = new SharedContext();
    ctx->temperature = 0.0f;
    ctx->humidity = 0.0f;
    ctx->dhtSampleValid = false;
    ctx->dhtSampledAtMs = 0;
    ctx->soilMoisture = 0;
    ctx->soilSampleValid = false;
    ctx->soilSampledAtMs = 0;
    ctx->ledState = 1;
    ctx->neoState = 1;
    ctx->lcdState = 1;
    ctx->timestampReal = 0;
    ctx->timestampRealUs = 0;
    snprintf(ctx->bootId, sizeof(ctx->bootId), "%08lx%08lx%08lx%08lx",
             static_cast<unsigned long>(esp_random()), static_cast<unsigned long>(esp_random()),
             static_cast<unsigned long>(esp_random()), static_cast<unsigned long>(esp_random()));
    ctx->mutexContext = xSemaphoreCreateMutex();
    ctx->semLEDUpdate = xSemaphoreCreateBinary();
    ctx->semNeoUpdate = xSemaphoreCreateBinary();
    ctx->semDBUpdate  = xSemaphoreCreateBinary();
    Webserver_init_context(ctx);

    xTaskCreate(led_blinky, "Task LED Blink", 2048, (void *)ctx, 2, NULL);
    xTaskCreate(neo_blinky, "Task NEO Blink", 2048, (void *)ctx, 2, NULL);
    // Float formatting, sensor I/O and WebSocket calls need nested stack headroom.
    if (xTaskCreate(temp_humi_monitor, "Task TEMP HUMI Monitor", 6144,
                    (void *)ctx, 2, NULL) != pdPASS) {
        Serial.println("[BOOT] Could not create sensor task");
    }
    xTaskCreate(task_fan, "Task Fan", 4096, (void *)ctx, 2, NULL);
    xTaskCreate(tiny_ml_task, "Tiny ML Task", 8192, (void *)ctx, 2, NULL);
    xTaskCreate(task_database, "Task Database", 16384, (void *)ctx, 2, NULL);
    xTaskCreate(Task_Toggle_BOOT, "Task Toggle BOOT", 4096, NULL, 2, NULL);
}

void loop()
{
    DNS_process();
    String switchSsid, switchPass;
    bool switchPending = false;
    if (xSemaphoreTake(g_wifiSwitchMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
        switchPending = g_wifiSwitchFlag;
        if (switchPending) {
            switchSsid = g_wifiSwitchSSID;
            switchPass = g_wifiSwitchPass;
            g_wifiSwitchFlag = false;
        }
        xSemaphoreGive(g_wifiSwitchMutex);
    }
    if (switchPending) Wifi_switch_to(switchSsid, switchPass);
    if (check_info_File(true)) {
        if (!Wifi_reconnect()) {
            Webserver_stop();
        }
    }
    Webserver_reconnect();
    vTaskDelay(pdMS_TO_TICKS(30));
}
