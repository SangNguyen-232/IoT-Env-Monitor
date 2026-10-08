#include "global.h"
#include "serial_log.h"
#include "esp_log.h"

#include "led_blinky.h"
#include "neo_blinky.h"
#include "temp_humi_monitor.h"
#include "tinyml.h"
#include "task_database.h"

#include "task_check_info.h"
#include "task_toogle_boot.h"
#include "task_wifi.h"
#include "task_webserver.h"
#include "pump.h"

void setup()
{
  Serial.begin(115200);
  serialLogInit();
  esp_log_level_set("*", ESP_LOG_NONE);
  esp_log_level_set("vfs_api", ESP_LOG_NONE);
  check_info_File(0);

  SharedContext* ctx = new SharedContext();
  ctx->temperature = 0;
  ctx->humidity = 0;
  ctx->soilMoisture = 0;
  ctx->soilRaw = 0;
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
  ctx->semLCDUpdate = xSemaphoreCreateBinary();
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
  if (g_wifiSwitchFlag) {
    g_wifiSwitchFlag = false;
    Wifi_switch_to(g_wifiSwitchSSID, g_wifiSwitchPass);
  }
  if (check_info_File(1))
  {
    if (!Wifi_reconnect())
    {
      Webserver_stop();
    }
  }
  Webserver_reconnect();
  vTaskDelay(pdMS_TO_TICKS(200));
}