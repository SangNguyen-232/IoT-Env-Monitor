#include "led_blinky.h"
#include "global.h"
 
void led_blinky(void *pvParameters){
  pinMode(LED_GPIO, OUTPUT);
  
  SharedContext* ctx = (SharedContext*)pvParameters;
  int delay_ms = 1000;
  
  while(1) {
    if (ctx != NULL) {
        xSemaphoreTake(ctx->mutexContext, portMAX_DELAY);
        int state = ctx->ledState;
        xSemaphoreGive(ctx->mutexContext);
        if (state == 3) delay_ms = 100;
        else if (state == 2) delay_ms = 500;
        else delay_ms = 1000;
    }
 
    digitalWrite(LED_GPIO, HIGH);  
    
    if (ctx != NULL) {
        if (xSemaphoreTake(ctx->semLEDUpdate, pdMS_TO_TICKS(delay_ms))) {
            digitalWrite(LED_GPIO, LOW);
            continue; 
        }
    } else {
        vTaskDelay(pdMS_TO_TICKS(delay_ms));
    }
    
    digitalWrite(LED_GPIO, LOW);  
    
    if (ctx != NULL) {
        if (xSemaphoreTake(ctx->semLEDUpdate, pdMS_TO_TICKS(delay_ms))) {
            continue;
        }
    } else {
        vTaskDelay(pdMS_TO_TICKS(delay_ms));
    }
  }
}