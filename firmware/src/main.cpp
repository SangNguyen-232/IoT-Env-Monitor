#include "shared_context.h"
#include "serial_log.h"
#include "esp_log.h"

#include "status_led.h"
#include "rgb_led.h"
#include "environment_monitor.h"
#include "tinyml.h"
#include "telemetry_client.h"

#include "device_config.h"
#include "factory_reset.h"
#include "wifi_manager.h"
#include "web_server.h"
#include "pump.h"

void setup()
{
    Serial.begin(115200);
    serialLogInit();
    esp_log_level_set("*", ESP_LOG_WARN);
    esp_log_level_set("vfs_api", ESP_LOG_NONE);
    check_info_File(false);

    SharedContext *ctx = new SharedContext();
    ctx->temperature = 0.0f;
    ctx->humidity = 0.0f;
    ctx->soilMoisture = 0;
    ctx->soilSampleValid = false;
    ctx->soilSampledAtMs = 0;
    ctx->ledState = 1;
    ctx->neoState = 1;
    ctx->lcdState = 1;
    ctx->timestampReal = 0;
    ctx->timestampRealUs = 0;
    ctx->mlRollAcc = 0.0f;
    strncpy(ctx->dbTriggerSource, "sensor", sizeof(ctx->dbTriggerSource) - 1);
    ctx->dbTriggerSource[sizeof(ctx->dbTriggerSource) - 1] = '\0';
    ctx->mutexContext = xSemaphoreCreateMutex();
    ctx->semLEDUpdate = xSemaphoreCreateBinary();
    ctx->semNeoUpdate = xSemaphoreCreateBinary();
    ctx->semDBUpdate  = xSemaphoreCreateBinary();

    Webserver_init_ctx(ctx);

    xTaskCreate(led_blinky, "Task LED Blink", 2048, (void *)ctx, 2, NULL);
    xTaskCreate(neo_blinky, "Task NEO Blink", 2048, (void *)ctx, 2, NULL);
    xTaskCreate(temp_humi_monitor, "Task TEMP HUMI Monitor", 2048, (void *)ctx, 2, NULL);
    xTaskCreate(task_pump, "Task Pump", 2048, (void *)ctx, 2, NULL);
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
