#include "neo_blinky.h"
#include "global.h"
 
void neo_blinky(void *pvParameters){
 
    Adafruit_NeoPixel strip(LED_COUNT, NEO_PIN, NEO_GRB + NEO_KHZ800);
    strip.begin();
    strip.clear();
    strip.show();
 
    SharedContext* ctx = (SharedContext*)pvParameters;
    
    if (ctx != NULL) {
        xSemaphoreTake(ctx->mutexContext, portMAX_DELAY);
        int state = ctx->neoState;
        xSemaphoreGive(ctx->mutexContext);
        
        if (state == 1) strip.setPixelColor(0, strip.Color(0, 255, 0)); 
        else if (state == 2) strip.setPixelColor(0, strip.Color(255, 255, 0)); 
        else if (state == 3) strip.setPixelColor(0, strip.Color(255, 0, 0)); 
        strip.show();
    }
 
    while(1) {                          
        if (ctx != NULL) {
            xSemaphoreTake(ctx->semNeoUpdate, portMAX_DELAY);
            
            xSemaphoreTake(ctx->mutexContext, portMAX_DELAY);
            int state = ctx->neoState;
            xSemaphoreGive(ctx->mutexContext);
            
            if (state == 1) { 
               strip.setPixelColor(0, strip.Color(0, 255, 0)); 
            } else if (state == 2) { // Warning
               strip.setPixelColor(0, strip.Color(255, 255, 0)); 
            } else if (state == 3) { // Critical
               strip.setPixelColor(0, strip.Color(255, 0, 0));
            }
            strip.show();
        } else {
            vTaskDelay(portMAX_DELAY);
        }
    }
}