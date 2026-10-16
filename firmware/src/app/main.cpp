#include "app/shared_context.h"
#include "diagnostics/serial_log.h"
#include "esp_log.h"
 
#include "indicators/status_led.h"
#include "indicators/rgb_led.h"
#include "sensors/environment_monitor.h"
#include "inference/tinyml.h"
#include "network/telemetry_client.h"
 
#include "storage/device_config.h"
#include "system/factory_reset.h"
#include "network/wifi_manager.h"
#include "web/web_server.h"
#include "control/pump.h"
 
void setup()
{
  Serial.begin(115200);
  serialLogInit();
  esp_log_level_set("*", ESP_LOG_WARN);
  esp_log_level_set("vfs_api", ESP_LOG_NONE);
  check_info_File(0);
 
  SharedContext* ctx = new SharedContext();
  ctx->temperature = 0;
  ctx->humidity = 0;
  ctx->soilMoisture = 0;
  ctx->soilRaw = 0;
  ctx->soilSampleValid = false;
  ctx->soilSampledAtMs = 0;
  ctx->ledState = 1;
  ctx->neoState = 1;
  ctx->lcdState = 1;
  ctx->mlPredicted = 1;
  ctx->mlConfidence = 0.0f;
  ctx->timestampReal = 0;
  ctx->timestampRealUs = 0;
  ctx->mlRollAcc = 0.0f;
  strncpy(ctx->mlStatus, "Normal", sizeof(ctx->mlStatus) - 1);
  ctx->mlStatus[sizeof(ctx->mlStatus) - 1] = '\0';
  strncpy(ctx->dbTriggerSource, "sensor", sizeof(ctx->dbTriggerSource) - 1);
  ctx->dbTriggerSource[sizeof(ctx->dbTriggerSource) - 1] = '\0';
  ctx->mutexContext = xSemaphoreCreateMutex();
  ctx->semLEDUpdate = xSemaphoreCreateBinary();
  ctx->semNeoUpdate = xSemaphoreCreateBinary();
  ctx->semDBUpdate  = xSemaphoreCreateBinary();
 
  Webserver_init_ctx(ctx);
 
  xTaskCreate(led_blinky, "Task LED Blink", 2048, (void*)ctx, 2, NULL);
  xTaskCreate(neo_blinky, "Task NEO Blink", 2048, (void*)ctx, 2, NULL);
  xTaskCreate(temp_humi_monitor, "Task TEMP HUMI Monitor", 2048, (void*)ctx, 2, NULL);
  xTaskCreate(task_pump, "Task Pump", 2048, (void *)ctx, 2, NULL); 
  xTaskCreate(tiny_ml_task, "Tiny ML Task", 8192, (void *)ctx, 2, NULL);  
  xTaskCreate(task_database, "Task Database", 16384, (void*)ctx, 2, NULL);
  xTaskCreate(Task_Toogle_BOOT, "Task_Toogle_BOOT", 4096, NULL, 2, NULL);
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
  if (check_info_File(1))
  {
    if (!Wifi_reconnect())
    {
      Webserver_stop();
    }
  }
  Webserver_reconnect();
  vTaskDelay(pdMS_TO_TICKS(30));
}
