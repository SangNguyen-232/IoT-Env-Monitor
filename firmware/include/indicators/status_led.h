#ifndef __LED_BLINKY__
#define __LED_BLINKY__
 
#include <Arduino.h>
#include "app/shared_context.h"
 
#define LED_GPIO 48
 
void led_blinky(void *pvParameters);
 
#endif